//! Decoder-verified generations for transcript mutations. Layout offsets and
//! their disk sidecars never prove storage integrity. The Host state lock owns
//! file writes; this mutex only protects the process-local proof registry.
use super::*;
use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard, OnceLock},
    time::SystemTime,
};

#[derive(Clone, PartialEq, Eq)]
struct Generation {
    identity: layout::FileIdentity,
    length: u64,
    modified: SystemTime,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    changed: i64,
    #[cfg(windows)]
    change_sequence: Option<i64>,
}

impl Generation {
    fn from_file(file: &File) -> Result<Self> {
        let metadata = file.metadata()?;
        Ok(Self {
            identity: layout::opened_file_identity(file, &metadata),
            length: metadata.len(),
            modified: metadata.modified()?,
            #[cfg(unix)]
            changed: {
                use std::os::unix::fs::MetadataExt;
                (metadata.ctime(), metadata.ctime_nsec())
            },
            #[cfg(windows)]
            changed: change_time(file)?,
            #[cfg(windows)]
            change_sequence: change_sequence(file),
        })
    }

    fn can_cache(&self) -> bool {
        let has_identity = matches!(self.identity, layout::FileIdentity::Available { .. });
        #[cfg(windows)]
        {
            has_identity && self.change_sequence.is_some()
        }
        #[cfg(not(windows))]
        {
            has_identity
        }
    }

    fn ensure_current(&self, file: &File, path: &Path) -> Result<()> {
        anyhow::ensure!(
            *self == Self::from_file(file)? && *self == Self::from_file(&File::open(path)?)?,
            "transcript changed while checking storage integrity: {}",
            path.display()
        );
        Ok(())
    }
}

#[cfg(windows)]
pub(super) fn change_time(file: &File) -> Result<i64> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO},
    };
    let mut info = FILE_BASIC_INFO::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileBasicInfo,
            (&mut info as *mut FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error()).context("read transcript change time");
    }
    Ok(info.ChangeTime)
}

/// Read the filesystem's per-file update sequence number. Windows change time
/// can remain unchanged for rapid writes within one system-clock tick, so it
/// is not by itself a safe cache generation. Filesystems without a readable
/// USN fall back to scanning the transcript on every mutation.
#[cfg(windows)]
fn change_sequence(file: &File) -> Option<i64> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::{
            GetLastError, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER,
            ERROR_JOURNAL_NOT_ACTIVE, ERROR_NOT_SUPPORTED, HANDLE,
        },
        System::{
            Ioctl::{FSCTL_READ_FILE_USN_DATA, READ_FILE_USN_DATA, USN_RECORD_V2},
            IO::DeviceIoControl,
        },
    };

    let input = READ_FILE_USN_DATA {
        MinMajorVersion: 2,
        MaxMajorVersion: 2,
    };
    // A USN record includes the file name (up to 255 UTF-16 code units on
    // supported filesystems); this covers the record header and that name.
    let mut output = [0u8; 1024];
    let mut returned = 0u32;
    let result = unsafe {
        DeviceIoControl(
            file.as_raw_handle() as HANDLE,
            FSCTL_READ_FILE_USN_DATA,
            (&input as *const READ_FILE_USN_DATA).cast(),
            size_of::<READ_FILE_USN_DATA>() as u32,
            output.as_mut_ptr().cast(),
            output.len() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        let error = unsafe { GetLastError() };
        if !matches!(
            error,
            ERROR_INVALID_FUNCTION
                | ERROR_INVALID_PARAMETER
                | ERROR_JOURNAL_NOT_ACTIVE
                | ERROR_NOT_SUPPORTED
        ) {
            tracing::debug!(
                error,
                "transcript USN unavailable; integrity proof will not be cached"
            );
        }
        return None;
    }

    if (returned as usize) < size_of::<USN_RECORD_V2>() {
        tracing::debug!(
            returned,
            "transcript USN record is truncated; integrity proof will not be cached"
        );
        return None;
    }
    // DeviceIoControl returns a byte buffer with no alignment guarantee.
    let record = unsafe { std::ptr::read_unaligned(output.as_ptr().cast::<USN_RECORD_V2>()) };
    let record_length = record.RecordLength as usize;
    if record.MajorVersion != 2
        || record_length < size_of::<USN_RECORD_V2>()
        || record_length > returned as usize
    {
        tracing::debug!(
            major_version = record.MajorVersion,
            record_length,
            returned,
            "transcript USN record is invalid; integrity proof will not be cached"
        );
        return None;
    }
    Some(record.Usn)
}

fn proofs() -> MutexGuard<'static, HashMap<PathBuf, Generation>> {
    static PROOFS: OnceLock<Mutex<HashMap<PathBuf, Generation>>> = OnceLock::new();
    PROOFS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("transcript storage integrity proof lock poisoned")
}

pub(super) fn invalidate(path: &Path) {
    proofs().remove(path);
}

/// The prefix was verified by prepare and the new line came from tagged().
/// Close the synced writer before reading its final metadata: Windows may
/// publish the last-write timestamp only when the write handle closes.
pub(super) fn appended(path: &Path, file: File) -> Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(());
    }
    let identity = layout::opened_file_identity(&file, &metadata);
    drop(file);
    let generation = Generation::from_file(&File::open(path)?)?;
    anyhow::ensure!(
        identity == generation.identity && metadata.len() == generation.length,
        "transcript changed after append: {}",
        path.display()
    );
    if generation.can_cache() {
        proofs().insert(path.to_path_buf(), generation);
    }
    Ok(())
}

/// A first mutation after restart or an outside rewrite checks every existing
/// line. Ordinary mutations reuse only a proof for this exact file generation.
pub(super) fn verify(path: &Path, reader: &mut BufReader<File>) -> Result<()> {
    let generation = Generation::from_file(reader.get_ref())?;
    generation.ensure_current(reader.get_ref(), path)?;
    let cached = proofs().get(path).cloned();
    if generation.can_cache() && cached.as_ref() == Some(&generation) {
        return Ok(());
    }
    invalidate(path);
    reader.seek(SeekFrom::Start(0))?;
    #[cfg(test)]
    SCANS.with(|scans| *scans.borrow_mut().entry(path.to_path_buf()).or_default() += 1);
    let mut raw = Vec::new();
    let mut line = String::new();
    loop {
        let (read, _) = read_line_tolerant(reader, &mut raw, &mut line)?;
        if read == 0 {
            break;
        }
        if let Err(error) = binary_storage::validate_line(line.trim()) {
            if binary_storage::is_error(&error) {
                return Err(error).with_context(|| format!("validate storage {}", path.display()));
            }
        }
        line.clear();
    }
    generation.ensure_current(reader.get_ref(), path)?;
    if generation.can_cache() {
        proofs().insert(path.to_path_buf(), generation);
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    // Count real full scans so the O(1) owned-append contract is reproducible
    // without wall-clock thresholds or depending on another test's activity.
    static SCANS: std::cell::RefCell<HashMap<PathBuf, usize>> = Default::default();
}

#[cfg(test)]
pub(super) fn scan_count(path: &Path) -> usize {
    SCANS.with(|scans| scans.borrow().get(path).copied().unwrap_or_default())
}

#[cfg(test)]
pub(super) fn can_cache_file(path: &Path) -> Result<bool> {
    let file = File::open(path)?;
    Ok(Generation::from_file(&file)?.can_cache())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_generation_requires_a_reliable_usn_and_detects_same_size_rewrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("generation.jsonl");
        fs::write(&path, b"first contents\n").unwrap();
        let before = Generation::from_file(&File::open(&path).unwrap()).unwrap();

        // Some Windows filesystems have no active USN journal. Those volumes
        // must rescan instead of trusting coarse timestamp generations.
        let Some(before_usn) = before.change_sequence else {
            assert!(!before.can_cache());
            return;
        };

        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, b"other contents\n").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();

        let after = Generation::from_file(&File::open(&path).unwrap()).unwrap();
        assert_ne!(after.change_sequence, Some(before_usn));
        assert!(after.can_cache());
    }

    #[cfg(windows)]
    #[test]
    fn windows_generation_without_usn_is_not_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("generation.jsonl");
        fs::write(&path, b"contents\n").unwrap();
        let mut generation = Generation::from_file(&File::open(&path).unwrap()).unwrap();
        generation.change_sequence = None;

        assert!(!generation.can_cache());
    }
}
