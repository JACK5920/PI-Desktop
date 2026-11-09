//! Platform-independent macOS text-input metadata and Unicode chunking.
//!
//! Keep these decisions testable on non-macOS hosts; the native event path is
//! exercised by the macOS fixture, while role and Unicode invariants are pure.

pub(super) fn is_editable_text_role(role: &str) -> bool {
    matches!(
        role,
        "AXTextField" | "AXTextArea" | "AXSearchField" | "AXComboBox" | "AXTextEntryArea"
    )
}

pub(super) fn is_secure_text_role(role: &str, subrole: Option<&str>) -> bool {
    role == "AXSecureTextField" || subrole == Some("AXSecureTextField")
}

const MAX_UNICODE_UNITS_PER_EVENT: usize = 20;

pub(super) fn unicode_text_chunks(text: &str) -> Vec<Vec<u16>> {
    let mut chunks = Vec::new();
    let mut chunk = Vec::with_capacity(MAX_UNICODE_UNITS_PER_EVENT);
    for character in text.chars() {
        let mut encoded = [0; 2];
        let encoded = character.encode_utf16(&mut encoded);
        if chunk.len() + encoded.len() > MAX_UNICODE_UNITS_PER_EVENT {
            chunks.push(std::mem::take(&mut chunk));
            chunk = Vec::with_capacity(MAX_UNICODE_UNITS_PER_EVENT);
        }
        chunk.extend_from_slice(encoded);
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editable_and_secure_accessibility_roles_are_classified() {
        for role in [
            "AXTextField",
            "AXTextArea",
            "AXSearchField",
            "AXComboBox",
            "AXTextEntryArea",
        ] {
            assert!(is_editable_text_role(role), "missing editable role {role}");
        }
        for role in ["AXSecureTextField", "AXButton", "AXStaticText", "AXWindow"] {
            assert!(
                !is_editable_text_role(role),
                "unexpected editable role {role}"
            );
        }
        assert!(is_secure_text_role("AXSecureTextField", None));
        assert!(is_secure_text_role(
            "AXTextField",
            Some("AXSecureTextField")
        ));
        assert!(!is_secure_text_role(
            "AXTextField",
            Some("AXStandardTextField")
        ));
        assert!(!is_secure_text_role("AXTextField", None));
    }

    #[test]
    fn unicode_text_chunks_preserve_surrogate_pairs_and_order() {
        let text = format!("{}🦢{}", "a".repeat(19), "界".repeat(25));
        let chunks = unicode_text_chunks(&text);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= MAX_UNICODE_UNITS_PER_EVENT));
        let rebuilt = chunks
            .iter()
            .map(|chunk| String::from_utf16(chunk).expect("complete Unicode scalars per chunk"))
            .collect::<String>();
        assert_eq!(rebuilt, text);
        assert!(unicode_text_chunks("").is_empty());
    }
}
