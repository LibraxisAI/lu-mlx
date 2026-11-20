//! Key names the model may send, parsed into a portable form.
//!
//! The model writes a chord the way people do: `ctrl+shift+t`, `enter`,
//! `cmd+space`. This file turns that into modifiers plus one key, refuses
//! what it does not know, and never guesses.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Modifier {
    Control,
    Shift,
    Alt,
    /// Windows key, Command, Super.
    Meta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyName {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    F(u8),
    /// A printable character, lower case for letters.
    Char(char),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Chord {
    pub modifiers: Vec<Modifier>,
    pub key: KeyName,
}

impl Chord {
    pub fn has(&self, modifier: Modifier) -> bool {
        self.modifiers.contains(&modifier)
    }
    pub fn is(&self, modifiers: &[Modifier], key: KeyName) -> bool {
        self.key == key && self.modifiers.len() == modifiers.len() && modifiers.iter().all(|m| self.has(*m))
    }
}

/// Does this chord put text into the field that has the focus? A character
/// or a space, alone or with Shift, and the paste chord of either system.
pub fn enters_text(chord: &Chord) -> bool {
    let prints = matches!(chord.key, KeyName::Char(_) | KeyName::Space) && chord.modifiers.iter().all(|m| *m == Modifier::Shift);
    // With Shift it is "paste as plain text" in most apps.
    let pastes = chord.key == KeyName::Char('v') && (chord.has(Modifier::Control) || chord.has(Modifier::Meta)) && !chord.has(Modifier::Alt);
    prints || pastes
}

fn modifier(token: &str) -> Option<Modifier> {
    Some(match token {
        "ctrl" | "control" | "strg" => Modifier::Control,
        "shift" => Modifier::Shift,
        "alt" | "option" | "opt" => Modifier::Alt,
        "meta" | "cmd" | "command" | "win" | "windows" | "super" => Modifier::Meta,
        _ => return None,
    })
}

fn key(token: &str) -> Option<KeyName> {
    Some(match token {
        "enter" | "return" => KeyName::Enter,
        "tab" => KeyName::Tab,
        "esc" | "escape" => KeyName::Escape,
        "backspace" => KeyName::Backspace,
        "delete" | "del" => KeyName::Delete,
        "space" | "spacebar" => KeyName::Space,
        "up" | "arrowup" => KeyName::Up,
        "down" | "arrowdown" => KeyName::Down,
        "left" | "arrowleft" => KeyName::Left,
        "right" | "arrowright" => KeyName::Right,
        "home" => KeyName::Home,
        "end" => KeyName::End,
        "pageup" | "pgup" => KeyName::PageUp,
        "pagedown" | "pgdn" => KeyName::PageDown,
        "plus" => KeyName::Char('+'),
        "minus" => KeyName::Char('-'),
        _ => {
            if let Some(number) = token.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                return (1..=20).contains(&number).then_some(KeyName::F(number));
            }
            let mut chars = token.chars();
            let first = chars.next()?;
            if chars.next().is_some() || first.is_control() || first.is_whitespace() {
                return None;
            }
            KeyName::Char(first)
        }
    })
}

/// Parse `ctrl+shift+t`. Case and spaces do not matter. Exactly one key that
/// is not a modifier, at the end.
pub fn parse_chord(input: &str) -> Result<Chord, String> {
    let lowered = input.trim().to_lowercase();
    if lowered.is_empty() || lowered.chars().count() > 40 {
        return Err("The key is empty or too long. Send one key or one chord such as ctrl+s.".to_string());
    }
    // "ctrl++" means control and the plus key.
    let normalized = if lowered == "+" {
        "plus".to_string()
    } else if let Some(rest) = lowered.strip_suffix("++") {
        format!("{rest}+plus")
    } else {
        lowered
    };
    let tokens: Vec<&str> = normalized.split('+').map(str::trim).collect();
    let (last, head) = tokens.split_last().ok_or_else(|| "The key is empty.".to_string())?;
    let mut modifiers = Vec::new();
    for token in head {
        let m = modifier(token).ok_or_else(|| format!("\"{token}\" is not a modifier key. Use ctrl, shift, alt or cmd, then one key."))?;
        if !modifiers.contains(&m) {
            modifiers.push(m);
        }
    }
    if modifier(last).is_some() {
        return Err("A chord needs one key after the modifiers, for example ctrl+c.".to_string());
    }
    let key = key(last).ok_or_else(|| format!("\"{last}\" is not a key LU knows. Use names such as enter, tab, escape, delete, up, f5 or a single character."))?;
    Ok(Chord { modifiers, key })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_keys_and_chords() {
        assert_eq!(parse_chord("Enter").unwrap(), Chord { modifiers: vec![], key: KeyName::Enter });
        assert_eq!(parse_chord("ctrl+c").unwrap(), Chord { modifiers: vec![Modifier::Control], key: KeyName::Char('c') });
        assert_eq!(
            parse_chord(" Ctrl + Shift + T ").unwrap(),
            Chord { modifiers: vec![Modifier::Control, Modifier::Shift], key: KeyName::Char('t') }
        );
        assert_eq!(parse_chord("cmd+space").unwrap().key, KeyName::Space);
        assert_eq!(parse_chord("alt+f4").unwrap().key, KeyName::F(4));
        assert_eq!(parse_chord("win+r").unwrap().modifiers, vec![Modifier::Meta]);
        assert_eq!(parse_chord("ctrl++").unwrap().key, KeyName::Char('+'));
        assert_eq!(parse_chord("+").unwrap().key, KeyName::Char('+'));
        assert_eq!(parse_chord("ä").unwrap().key, KeyName::Char('ä'));
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        assert!(parse_chord("").is_err());
        assert!(parse_chord("ctrl").is_err());
        assert!(parse_chord("ctrl+shift").is_err());
        assert!(parse_chord("hyper+k").is_err());
        assert!(parse_chord("ctrl+enterr").is_err());
        assert!(parse_chord("f99").is_err());
        assert!(parse_chord("a+b").is_err());
        assert!(parse_chord(&"x".repeat(100)).is_err());
    }

    #[test]
    fn characters_and_the_paste_chord_enter_text_and_nothing_else_does() {
        for keys in ["a", "shift+a", "7", "space", "shift+space", "ä", "ctrl+v", "cmd+v", "ctrl+shift+v"] {
            assert!(enters_text(&parse_chord(keys).unwrap()), "{keys}");
        }
        for keys in ["tab", "shift+tab", "escape", "enter", "backspace", "delete", "left", "ctrl+a", "ctrl+c", "alt+v", "f5"] {
            assert!(!enters_text(&parse_chord(keys).unwrap()), "{keys}");
        }
    }

    #[test]
    fn chord_comparison_ignores_modifier_order() {
        let chord = parse_chord("alt+ctrl+escape").unwrap();
        assert!(chord.is(&[Modifier::Control, Modifier::Alt], KeyName::Escape));
        assert!(!chord.is(&[Modifier::Control], KeyName::Escape));
    }
}
