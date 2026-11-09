use super::*;

#[test]
fn parses_supported_key_chords_and_rejects_ambiguous_or_system_keys() {
    assert_eq!(
        parse_key_chord("ctrl+shift+a"),
        Some(KeyChord {
            key: u32::from(b'a'),
            control: true,
            shift: true,
            alt: false,
        })
    );
    assert_eq!(keysym("enter"), Some(XK_RETURN));
    assert_eq!(keysym("F12"), Some(0xffc9));
    assert_eq!(parse_key_chord("alt+left").unwrap().key, XK_LEFT);
    assert_eq!(parse_key_chord("ctrl+ctrl+a"), None);
    assert_eq!(parse_key_chord("win+r"), None);
    assert_eq!(parse_key_chord("ctrl+alt+shift+a"), None);
    assert_eq!(parse_key_chord("😀"), None);
}
