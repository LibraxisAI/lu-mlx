//! Which actions get a confirmation even in an autonomous session: sending,
//! buying, deleting and changing permissions.
//!
//! This is a heuristic over what little is known before the action runs: the
//! name and role of the element under the click, the key, and the element
//! that holds the focus. It is tuned to ask once too often, never once too
//! rarely: an unknown target counts as sensitive.

use super::blocklist::Platform;
use super::keys::{Chord, KeyName, Modifier};
use super::types::ElementInfo;

/// Words that mark a control as one of the four kinds. English first, then
/// the German words a German Windows shows for the same buttons.
const WORDS: &[(&str, &str)] = &[
    // submit
    ("send", "sends something"), ("submit", "submits a form"), ("post", "posts something"),
    ("publish", "publishes something"), ("reply", "sends a reply"), ("share", "shares something"),
    ("sign in", "signs in"), ("log in", "signs in"), ("login", "signs in"), ("sign up", "creates an account"),
    ("senden", "sends something"), ("absenden", "sends something"), ("antworten", "sends a reply"),
    ("anmelden", "signs in"), ("teilen", "shares something"),
    // buy
    ("buy", "buys something"), ("purchase", "buys something"), ("pay", "pays"), ("order", "places an order"),
    ("checkout", "starts a payment"), ("check out", "starts a payment"), ("subscribe", "starts a subscription"),
    ("donate", "sends money"), ("transfer", "moves money or data"), ("upgrade", "may start a payment"),
    ("kaufen", "buys something"), ("bezahlen", "pays"), ("zahlen", "pays"), ("bestellen", "places an order"),
    ("abonnieren", "starts a subscription"),
    // delete
    ("delete", "deletes something"), ("remove", "removes something"), ("erase", "erases something"),
    ("discard", "discards something"), ("uninstall", "uninstalls something"), ("format", "may erase a drive"),
    ("empty", "may empty a folder"), ("reset", "resets something"), ("wipe", "erases something"),
    ("löschen", "deletes something"), ("loeschen", "deletes something"), ("entfernen", "removes something"),
    ("trash", "moves something to the trash"), ("recycle bin", "moves something to the recycle bin"),
    ("papierkorb", "moves something to the recycle bin"), ("verwerfen", "discards something"), ("deinstallieren", "uninstalls something"), ("zurücksetzen", "resets something"),
    // permissions
    ("allow", "grants a permission"), ("grant", "grants a permission"), ("permit", "grants a permission"),
    ("authorize", "grants access"), ("authorise", "grants access"), ("accept", "accepts something"),
    ("agree", "accepts terms"), ("install", "installs software"), ("trust", "trusts something"),
    ("enable", "turns something on"), ("run", "runs a program"), ("open anyway", "bypasses a warning"),
    ("zulassen", "grants a permission"), ("erlauben", "grants a permission"), ("akzeptieren", "accepts something"),
    ("zustimmen", "accepts terms"), ("installieren", "installs software"), ("ausführen", "runs a program"),
    ("clear", "clears something"), ("replace", "replaces something"), ("overwrite", "overwrites something"),
    ("bin", "moves something to the bin"), ("leeren", "empties something"), ("ersetzen", "replaces something"),
    ("überschreiben", "overwrites something"),
    ("withdraw", "moves money"), ("sell", "sells something"), ("bid", "places a bid"), ("überweisen", "moves money"),
    ("überweisung", "moves money"), ("buchen", "books something"), ("abschicken", "sends something"),
    ("log out", "signs the user out"), ("logout", "signs the user out"), ("ausloggen", "signs the user out"),
    // power
    ("shut down", "shuts the computer down"), ("restart", "restarts something"), ("sign out", "signs the user out"),
    ("log off", "signs the user out"), ("herunterfahren", "shuts the computer down"), ("neu starten", "restarts something"),
    ("abmelden", "signs the user out"),
    // the buttons of a confirmation dialog
    ("ok", "confirms a dialog"), ("yes", "confirms a dialog"), ("confirm", "confirms a dialog"),
    ("continue", "confirms a step"), ("proceed", "confirms a step"), ("apply", "applies changes"),
    ("ja", "confirms a dialog"), ("bestätigen", "confirms a dialog"), ("fortfahren", "confirms a step"),
    ("weiter", "confirms a step"), ("übernehmen", "applies changes"),
];

const SENDS: &str = "sends something";
const BUYS: &str = "buys or pays for something";
const DELETES: &str = "deletes something";
const SIGNS_IN: &str = "signs in";
const GRANTS: &str = "grants a permission or installs something";
const CONFIRMS: &str = "confirms a dialog";

/// The same buttons in other languages a system or a web page may speak:
/// French, Spanish, Italian, Portuguese, Dutch, Polish, Turkish, Russian.
/// Matched as whole words, like `WORDS`. Only the core of each kind: this is
/// a net under the English list, not a dictionary.
const WORDS_ABROAD: &[(&str, &str)] = &[
    // French
    ("envoyer", SENDS), ("publier", SENDS), ("répondre", SENDS), ("partager", SENDS), ("acheter", BUYS), ("payer", BUYS),
    ("commander", BUYS), ("supprimer", DELETES), ("effacer", DELETES), ("se connecter", SIGNS_IN), ("connexion", SIGNS_IN),
    ("autoriser", GRANTS), ("accepter", GRANTS), ("installer", GRANTS), ("confirmer", CONFIRMS), ("oui", CONFIRMS), ("valider", CONFIRMS),
    // Spanish and Portuguese
    ("enviar", SENDS), ("publicar", SENDS), ("responder", SENDS), ("compartir", SENDS), ("compartilhar", SENDS), ("comprar", BUYS),
    ("pagar", BUYS), ("pedir", BUYS), ("eliminar", DELETES), ("borrar", DELETES), ("excluir", DELETES), ("apagar", DELETES),
    ("iniciar sesión", SIGNS_IN), ("entrar", SIGNS_IN), ("permitir", GRANTS), ("aceptar", GRANTS), ("aceitar", GRANTS),
    ("instalar", GRANTS), ("confirmar", CONFIRMS), ("sí", CONFIRMS),
    // Italian
    ("invia", SENDS), ("inviare", SENDS), ("pubblica", SENDS), ("rispondi", SENDS), ("condividi", SENDS), ("acquista", BUYS),
    ("compra", BUYS), ("paga", BUYS), ("ordina", BUYS), ("elimina", DELETES), ("cancella", DELETES), ("accedi", SIGNS_IN),
    ("consenti", GRANTS), ("accetta", GRANTS), ("installa", GRANTS), ("conferma", CONFIRMS), ("sì", CONFIRMS),
    // Dutch
    ("verzenden", SENDS), ("versturen", SENDS), ("plaatsen", SENDS), ("delen", SENDS), ("kopen", BUYS), ("betalen", BUYS),
    ("bestellen", BUYS), ("verwijderen", DELETES), ("inloggen", SIGNS_IN), ("aanmelden", SIGNS_IN),
    ("toestaan", GRANTS), ("accepteren", GRANTS), ("installeren", GRANTS), ("bevestigen", CONFIRMS),
    // Polish
    ("wyślij", SENDS), ("opublikuj", SENDS), ("odpowiedz", SENDS), ("udostępnij", SENDS), ("kup", BUYS), ("zapłać", BUYS),
    ("zamów", BUYS), ("usuń", DELETES), ("zaloguj", SIGNS_IN), ("zezwól", GRANTS), ("akceptuj", GRANTS), ("zainstaluj", GRANTS),
    ("potwierdź", CONFIRMS), ("tak", CONFIRMS),
    // Turkish
    ("gönder", SENDS), ("paylaş", SENDS), ("yanıtla", SENDS), ("satın al", BUYS), ("öde", BUYS), ("sipariş ver", BUYS),
    ("sil", DELETES), ("kaldır", DELETES), ("giriş yap", SIGNS_IN), ("oturum aç", SIGNS_IN), ("izin ver", GRANTS),
    ("kabul et", GRANTS), ("yükle", GRANTS), ("onayla", CONFIRMS), ("evet", CONFIRMS),
    // Russian
    ("отправить", SENDS), ("опубликовать", SENDS), ("ответить", SENDS), ("поделиться", SENDS), ("купить", BUYS),
    ("оплатить", BUYS), ("заказать", BUYS), ("перевести", BUYS), ("удалить", DELETES), ("очистить", DELETES), ("войти", SIGNS_IN),
    ("разрешить", GRANTS), ("принять", GRANTS), ("установить", GRANTS), ("подтвердить", CONFIRMS), ("да", CONFIRMS),
];

/// Chinese, Japanese and Korean write no spaces, so these are matched
/// anywhere in the name.
const WORDS_UNSPACED: &[(&str, &str)] = &[
    ("发送", SENDS), ("發送", SENDS), ("提交", SENDS), ("发布", SENDS), ("發佈", SENDS), ("分享", SENDS), ("购买", BUYS), ("購買", BUYS),
    ("支付", BUYS), ("付款", BUYS), ("下单", BUYS), ("下單", BUYS), ("转账", BUYS), ("轉帳", BUYS), ("删除", DELETES), ("刪除", DELETES),
    ("清空", DELETES), ("登录", SIGNS_IN), ("登入", SIGNS_IN), ("允许", GRANTS), ("允許", GRANTS), ("同意", GRANTS), ("安装", GRANTS),
    ("安裝", GRANTS), ("确认", CONFIRMS), ("確認", CONFIRMS), ("确定", CONFIRMS), ("確定", CONFIRMS),
    ("送信", SENDS), ("投稿", SENDS), ("返信", SENDS), ("共有", SENDS), ("購入", BUYS), ("支払", BUYS), ("注文", BUYS), ("削除", DELETES),
    ("ログイン", SIGNS_IN), ("サインイン", SIGNS_IN), ("許可", GRANTS), ("インストール", GRANTS), ("はい", CONFIRMS),
    ("보내기", SENDS), ("전송", SENDS), ("게시", SENDS), ("공유", SENDS), ("구매", BUYS), ("결제", BUYS), ("주문", BUYS), ("삭제", DELETES),
    ("로그인", SIGNS_IN), ("허용", GRANTS), ("동의", GRANTS), ("설치", GRANTS), ("확인", CONFIRMS),
];

/// Roles where the name is a label of a text area, not the name of a command.
fn is_text_container(role: &str) -> bool {
    matches!(role.to_lowercase().as_str(), "edit" | "document" | "text field" | "textarea")
}

fn word_hit(name: &str) -> Option<(&'static str, &'static str)> {
    // The Turkish capital I with a dot lowers to "i" plus a combining dot.
    let lowered = name.to_lowercase().replace('\u{307}', "");
    let is_word_char = |c: char| c.is_alphanumeric();
    let whole_word = |(word, _): &(&str, &str)| {
        lowered.match_indices(word).any(|(at, hit)| {
            let before = lowered[..at].chars().next_back();
            let after = lowered[at + hit.len()..].chars().next();
            !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
        })
    };
    WORDS
        .iter()
        .chain(WORDS_ABROAD)
        .copied()
        .find(|entry| whole_word(entry))
        .or_else(|| WORDS_UNSPACED.iter().copied().find(|(word, _)| lowered.contains(word)))
}

/// Roles that are a command by themselves: pressing one does something.
fn is_command(role: &str) -> bool {
    matches!(role.to_lowercase().as_str(), "button" | "splitbutton" | "hyperlink" | "menuitem")
}

/// The role and the name a click target or the focused element is judged by.
/// `ancestors` are its parents, nearest first, as (role, name).
///
/// The text of a button is often a nameless child, so a target without a
/// name takes the name of the nearest parent that has one. That stops at a
/// command: a button without a name of its own (a symbol, like the arrow
/// that sends) is not named after the toolbar or the pane around it, where
/// it would read like any harmless control. It stays nameless, and
/// `sensitive_click` asks for it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn named_target(role: String, name: String, ancestors: impl IntoIterator<Item = (String, String)>) -> (String, String) {
    if !name.trim().is_empty() || is_command(&role) {
        return (role, name);
    }
    for (parent_role, parent_name) in ancestors {
        if !parent_name.trim().is_empty() {
            return (role, parent_name);
        }
        if is_command(&parent_role) {
            return (parent_role, String::new());
        }
    }
    (role, name)
}

/// A click. `element` is what the platform found under the pointer; `None`
/// means the platform could not say, which counts as sensitive.
pub fn sensitive_click(element: Option<&ElementInfo>) -> Option<String> {
    let Some(element) = element else {
        return Some("LU cannot tell what this click would press.".to_string());
    };
    if is_text_container(&element.role) {
        return None;
    }
    // A command without a name says nothing about what it does.
    if element.name.trim().is_empty() && is_command(&element.role) {
        return Some("The click target is a button without a name, so LU cannot tell what it would press.".to_string());
    }
    let (word, effect) = word_hit(&element.name)?;
    Some(format!("The click target \"{}\" contains \"{word}\", which usually {effect}.", shorten(&element.name)))
}

/// File name endings the system runs when the file is opened: programs,
/// installers, scripts and the shortcuts that point at them.
const RUNS_WHEN_OPENED: &[&str] = &[
    ".exe", ".com", ".scr", ".pif", ".cpl", ".msi", ".msix", ".appx", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse",
    ".wsf", ".wsh", ".hta", ".reg", ".lnk", ".url", ".jar", ".py", ".pyw", ".sh", ".command", ".app", ".pkg", ".dmg",
    ".appimage", ".desktop", ".deb", ".rpm", ".run",
];

/// A double click, which opens what it hits. On top of what a click is
/// judged by: opening a program, an installer or a script runs it.
pub fn sensitive_open(element: Option<&ElementInfo>) -> Option<String> {
    let element = element?;
    if is_text_container(&element.role) {
        return None;
    }
    let name = element.name.trim().to_lowercase();
    let ending = RUNS_WHEN_OPENED.iter().find(|ending| name.ends_with(*ending) && name.len() > ending.len())?;
    Some(format!("The double click target \"{}\" ends in \"{ending}\", and opening such a file can run a program.", shorten(&element.name)))
}

/// A key or chord. `focused` is the element that holds the keyboard focus.
pub fn sensitive_key(chord: &Chord, focused: Option<&ElementInfo>) -> Option<String> {
    let in_document = focused.is_some_and(|f| f.role.eq_ignore_ascii_case("document"));
    let in_text = focused.is_some_and(|f| is_text_container(&f.role));
    match chord.key {
        // Enter submits a form, presses the default button and sends a
        // message. Only inside a document is it a line break for certain.
        KeyName::Enter if !(in_document && chord.modifiers.is_empty()) => {
            Some("Enter can submit a form or confirm a dialog.".to_string())
        }
        // Delete removes files and items. Inside text it removes a character.
        KeyName::Delete if !in_text || chord.has(Modifier::Shift) => Some("Delete can remove a file or an item.".to_string()),
        // Command+Backspace moves to the Trash on macOS.
        KeyName::Backspace if chord.has(Modifier::Meta) => Some("This chord can move a file to the Trash.".to_string()),
        // System menus that lead to launchers and settings. The chords that
        // open a launcher directly are refused by the blocklist before this.
        KeyName::Space if chord.is(&[Modifier::Meta], KeyName::Space) => Some("This chord opens a system menu or launcher.".to_string()),
        KeyName::Escape if chord.is(&[Modifier::Control], KeyName::Escape) => Some("This chord opens the Start menu.".to_string()),
        KeyName::Char('x') if chord.is(&[Modifier::Meta], KeyName::Char('x')) => Some("This chord opens the system menu.".to_string()),
        // Outside a text field a character is not a character. Space presses
        // the button that has the focus, and a letter presses the button
        // with that access key ("y" for Yes in a message box) or runs a
        // one-key command of the app. Judged like a click, with the same
        // rule for a target LU cannot name.
        KeyName::Space | KeyName::Char(_) if !in_text && chord.modifiers.iter().all(|m| *m == Modifier::Shift) => Some(match focused {
            Some(control) if !control.name.trim().is_empty() => format!(
                "This key is pressed outside a text field, where it can press \"{}\" or run a command of the app.",
                shorten(&control.name)
            ),
            Some(_) => "This key is pressed outside a text field, where it can press a button or run a command of the app.".to_string(),
            None => "LU cannot tell which control has the focus, and this key can press a button or run a command of the app.".to_string(),
        }),
        _ => None,
    }
}

/// Alt with a character. On Windows and Linux that is an access key: it
/// presses the button or opens the menu that carries the underlined letter,
/// from anywhere in the window and also out of a text field (Alt+S sends in
/// a mail program). Judged like a click on a control LU cannot name. On
/// macOS Option with a character types a character, so nothing is asked.
/// Control with Alt is the AltGr key, which types too.
pub fn sensitive_access_key(platform: Platform, chord: &Chord) -> Option<String> {
    let access_key = matches!(chord.key, KeyName::Char(_))
        && chord.has(Modifier::Alt)
        && !chord.has(Modifier::Control)
        && !chord.has(Modifier::Meta)
        && platform != Platform::MacOs;
    access_key.then(|| "Alt with a character presses the button or opens the menu with that access key, and LU cannot tell which one.".to_string())
}

/// Typed text. A line break is an Enter key, and a tab is a Tab key: outside
/// a document it moves the focus, and what follows lands in the next field
/// or on the next button.
pub fn sensitive_text(text: &str, focused: Option<&ElementInfo>) -> Option<String> {
    let in_document = focused.is_some_and(|f| f.role.eq_ignore_ascii_case("document"));
    if in_document {
        return None;
    }
    if text.contains(['\n', '\r']) {
        return Some("The text contains a line break, which can submit a form or send a message.".to_string());
    }
    text.contains('\t').then(|| "The text contains a tab, which moves the focus to another field or button.".to_string())
}

fn shorten(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
    clean.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::super::keys::parse_chord;
    use super::*;

    fn el(role: &str, name: &str) -> ElementInfo {
        ElementInfo { role: role.into(), name: name.into(), password: false }
    }

    #[test]
    fn the_four_kinds_of_buttons_are_sensitive() {
        for name in [
            "Send", "Submit", "Buy now", "Pay $12.00", "Place order", "Delete", "Remove account", "Allow", "Grant access",
            "Install", "Post", "Sign in", "Empty Trash", "Uninstall", "OK", "Yes", "Löschen", "Jetzt kaufen", "Zulassen",
            "Shut down", "Restart", "Herunterfahren", "Neu starten", "Abmelden",
        ] {
            assert!(sensitive_click(Some(&el("Button", name))).is_some(), "{name} must ask");
        }
    }

    /// The list knew English and German. On a system or a web page in
    /// another language "Envoyer", "Comprar" or "Удалить" was an ordinary
    /// button, and an autonomous session pressed it without a question.
    #[test]
    fn the_same_buttons_ask_in_other_languages() {
        for name in [
            "Envoyer", "Acheter maintenant", "Payer", "Supprimer", "Commander", "Se connecter", "Autoriser", "Installer", "Confirmer", "Oui",
            "Enviar", "Comprar ahora", "Pagar", "Eliminar", "Borrar", "Iniciar sesión", "Permitir", "Instalar", "Confirmar", "Sí", "Aceptar",
            "Invia", "Acquista", "Paga ora", "Elimina", "Accedi", "Consenti", "Installa", "Conferma",
            "Excluir", "Entrar", "Verzenden", "Kopen", "Betalen", "Verwijderen", "Inloggen", "Toestaan", "Bevestigen",
            "Wyślij", "Kup teraz", "Zapłać", "Usuń", "Zaloguj się", "Zezwól", "Zainstaluj", "Potwierdź",
            "Gönder", "Satın al", "Öde", "Sil", "Giriş yap", "İzin ver", "Onayla",
            "Отправить", "Купить", "Оплатить", "Удалить", "Войти", "Разрешить", "Установить", "Подтвердить", "Да",
            "发送", "立即购买", "支付", "删除", "登录", "允许", "安装", "确认", "確定",
            "送信", "購入する", "支払う", "削除", "ログイン", "許可", "インストール",
            "보내기", "구매하기", "결제", "삭제", "로그인", "허용", "설치", "확인",
        ] {
            assert!(sensitive_click(Some(&el("Button", name))).is_some(), "{name} must ask");
        }
    }

    #[test]
    fn more_english_and_german_buttons_that_send_spend_or_destroy() {
        for name in [
            "Clear browsing data", "Log out", "Logout", "Replace", "Overwrite", "Withdraw", "Sell", "Place bid", "Move to bin",
            "Überweisen", "Ersetzen", "Überschreiben", "Papierkorb leeren", "Abschicken", "Jetzt buchen", "Ausloggen",
        ] {
            assert!(sensitive_click(Some(&el("Button", name))).is_some(), "{name} must ask");
        }
    }

    #[test]
    fn ordinary_controls_in_other_languages_stay_quiet() {
        for name in ["Fichier", "Suivant", "Rechercher", "Annuler", "Archivo", "Buscar", "Cancelar", "Zoeken", "Файл", "Поиск", "Отмена", "文件", "搜索", "取消", "ファイル", "検索", "파일", "취소"] {
            let hit = sensitive_click(Some(&el("Button", name)));
            assert!(hit.is_none(), "{name} must not ask: {hit:?}");
        }
    }

    #[test]
    fn ordinary_controls_are_not() {
        for name in ["File", "Next page", "Search", "Bold", "Zoom in", "New tab", "Cancel", "Close", "Back", "Postcode", "Sender list", "Okay then", "Payment history"] {
            let hit = sensitive_click(Some(&el("Button", name)));
            assert!(hit.is_none(), "{name} must not ask: {hit:?}");
        }
    }

    #[test]
    fn words_match_whole_words_only() {
        assert!(sensitive_click(Some(&el("Button", "Resend code"))).is_none());
        assert!(sensitive_click(Some(&el("Button", "Send code"))).is_some());
        assert!(sensitive_click(Some(&el("Hyperlink", "Reorder list"))).is_none());
        assert!(sensitive_click(Some(&el("MenuItem", "Delete..."))).is_some());
    }

    #[test]
    fn a_text_area_is_judged_as_a_place_to_type_not_as_a_command() {
        assert!(sensitive_click(Some(&el("Edit", "Reason to delete"))).is_none());
        assert!(sensitive_click(Some(&el("Document", "Send feedback"))).is_none());
    }

    #[test]
    fn an_unknown_click_target_is_sensitive() {
        assert!(sensitive_click(None).is_some());
    }

    /// A symbol button has no name. It went through as an ordinary control,
    /// against the rule at the top of this file.
    #[test]
    fn a_command_without_a_name_is_sensitive() {
        for role in ["Button", "SplitButton", "Hyperlink", "MenuItem", "button"] {
            let hit = sensitive_click(Some(&el(role, ""))).unwrap_or_else(|| panic!("{role} must ask"));
            assert!(hit.contains("without a name"), "{hit}");
            assert!(sensitive_click(Some(&el(role, "   "))).is_some(), "{role}");
        }
        // A named one is judged by its name, as before.
        assert!(sensitive_click(Some(&el("Button", "Bold"))).is_none());
        // A place without a name that is no command: the blank part of a
        // pane, a picture, a list. A click there presses nothing.
        for role in ["Pane", "Group", "Image", "List", "Text", "Window", "Edit", "Document"] {
            assert!(sensitive_click(Some(&el(role, ""))).is_none(), "{role}");
        }
    }

    #[test]
    fn a_nameless_target_takes_the_name_of_a_parent_but_not_past_a_command() {
        let s = |text: &str| text.to_string();
        let parents = |list: &[(&str, &str)]| list.iter().map(|(role, name)| (s(role), s(name))).collect::<Vec<_>>();
        // The nameless text of a button is named by the button.
        assert_eq!(named_target(s("Text"), s(""), parents(&[("Button", "Send")])), (s("Text"), s("Send")));
        // Its own name wins, and no parent is asked for it.
        let never = std::iter::from_fn(|| -> Option<(String, String)> { panic!("the parents were asked") });
        assert_eq!(named_target(s("Button"), s("Bold"), never), (s("Button"), s("Bold")));
        // A symbol button is not named after its toolbar.
        let never = std::iter::from_fn(|| -> Option<(String, String)> { panic!("the parents were asked") });
        assert_eq!(named_target(s("Button"), s(""), never), (s("Button"), s("")));
        // Neither is the picture inside it: it reads as that nameless button.
        let symbol = named_target(s("Image"), s(""), parents(&[("Button", ""), ("ToolBar", "Compose toolbar")]));
        assert_eq!(symbol, (s("Button"), s("")));
        let (role, name) = symbol;
        assert!(sensitive_click(Some(&el(&role, &name))).is_some());
        // Without a command on the way the nearest name is taken, as before.
        assert_eq!(named_target(s("Image"), s(""), parents(&[("Group", ""), ("ToolBar", "Compose toolbar")])), (s("Image"), s("Compose toolbar")));
        assert_eq!(named_target(s("Pane"), s(""), parents(&[("Pane", ""), ("Pane", "")])), (s("Pane"), s("")));
    }

    #[test]
    fn opening_a_program_or_script_is_sensitive_and_opening_a_document_is_not() {
        for name in ["setup.exe", "Invoice.PDF.EXE", "run.bat", "deploy.ps1", "Tool.lnk", "LU.app", "install.command", "build.sh"] {
            assert!(sensitive_open(Some(&el("ListItem", name))).is_some(), "{name}");
        }
        for name in ["notes.txt", "report.docx", "photo.jpg", "Documents", "exe", ".sh", "archive.zip"] {
            assert!(sensitive_open(Some(&el("ListItem", name))).is_none(), "{name}");
        }
        // A word selected in an editor is not a file.
        assert!(sensitive_open(Some(&el("Document", "main.py"))).is_none());
        // What LU cannot name is already sensitive as a click.
        assert!(sensitive_open(None).is_none());
    }

    #[test]
    fn enter_asks_except_inside_a_document() {
        let enter = parse_chord("enter").unwrap();
        assert!(sensitive_key(&enter, None).is_some());
        assert!(sensitive_key(&enter, Some(&el("Edit", "Search"))).is_some());
        assert!(sensitive_key(&enter, Some(&el("Button", "Next"))).is_some());
        assert!(sensitive_key(&enter, Some(&el("Document", "Text editor"))).is_none());
        assert!(sensitive_key(&parse_chord("ctrl+enter").unwrap(), Some(&el("Document", "Mail body"))).is_some());
    }

    #[test]
    fn delete_asks_outside_text() {
        let delete = parse_chord("delete").unwrap();
        assert!(sensitive_key(&delete, Some(&el("ListItem", "report.docx"))).is_some());
        assert!(sensitive_key(&delete, None).is_some());
        assert!(sensitive_key(&delete, Some(&el("Edit", "Name"))).is_none());
        assert!(sensitive_key(&parse_chord("shift+delete").unwrap(), Some(&el("Edit", "Name"))).is_some());
        assert!(sensitive_key(&parse_chord("cmd+backspace").unwrap(), None).is_some());
    }

    #[test]
    fn system_menu_chords_ask() {
        assert!(sensitive_key(&parse_chord("win+space").unwrap(), None).is_some());
        assert!(sensitive_key(&parse_chord("win+x").unwrap(), None).is_some());
        assert!(sensitive_key(&parse_chord("ctrl+escape").unwrap(), None).is_some());
    }

    #[test]
    fn ordinary_keys_do_not_ask() {
        for chord in ["tab", "escape", "ctrl+c", "ctrl+v", "ctrl+a", "down", "pagedown", "backspace", "ctrl+r", "f5"] {
            assert!(sensitive_key(&parse_chord(chord).unwrap(), None).is_none(), "{chord}");
        }
        // A character is ordinary where it is a character.
        for chord in ["a", "shift+a", "space", "7"] {
            assert!(sensitive_key(&parse_chord(chord).unwrap(), Some(&el("Edit", "Message"))).is_none(), "{chord}");
            assert!(sensitive_key(&parse_chord(chord).unwrap(), Some(&el("Document", "Editor"))).is_none(), "{chord}");
        }
    }

    /// Alt+S sends in a mail program and Alt+Y answers "Yes" in a message
    /// box, with the focus in a text field as well. Both went through
    /// without a question in an autonomous session.
    #[test]
    fn alt_with_a_character_asks_where_it_is_an_access_key() {
        for platform in [Platform::Windows, Platform::Linux] {
            for chord in ["alt+s", "alt+y", "alt+shift+d", "alt+1"] {
                assert!(sensitive_access_key(platform, &parse_chord(chord).unwrap()).is_some(), "{chord} on {platform:?}");
            }
            // Not an access key: no character, AltGr, or no Alt at all.
            for chord in ["alt+tab", "alt+left", "alt+f4", "ctrl+alt+q", "s", "ctrl+s", "shift+s", "alt+space"] {
                assert!(sensitive_access_key(platform, &parse_chord(chord).unwrap()).is_none(), "{chord} on {platform:?}");
            }
        }
        // Option with a character types a character on a Mac.
        assert!(sensitive_access_key(Platform::MacOs, &parse_chord("alt+s").unwrap()).is_none());
    }

    /// The chord that opens "Clear browsing data" in a browser.
    #[test]
    fn control_shift_delete_asks_everywhere() {
        let chord = parse_chord("ctrl+shift+delete").unwrap();
        assert!(sensitive_key(&chord, None).is_some());
        assert!(sensitive_key(&chord, Some(&el("Edit", "Address"))).is_some());
        assert!(sensitive_key(&chord, Some(&el("Document", "Page"))).is_some());
    }

    #[test]
    fn a_character_outside_a_text_field_asks() {
        let space = parse_chord("space").unwrap();
        let hit = sensitive_key(&space, Some(&el("Button", "Send"))).expect("space on a button presses it");
        assert!(hit.contains("Send"), "{hit}");
        assert!(sensitive_key(&parse_chord("y").unwrap(), Some(&el("Button", "No"))).is_some());
        assert!(sensitive_key(&parse_chord("shift+3").unwrap(), Some(&el("ListItem", "Inbox"))).is_some());
        assert!(sensitive_key(&space, Some(&el("Pane", ""))).is_some());
        // Unknown focus is not "inside text".
        assert!(sensitive_key(&space, None).is_some());
        assert!(sensitive_key(&parse_chord("a").unwrap(), None).is_some());
    }

    #[test]
    fn a_line_break_in_typed_text_counts_as_enter() {
        assert!(sensitive_text("hello\n", None).is_some());
        assert!(sensitive_text("hello\n", Some(&el("Edit", "Message"))).is_some());
        assert!(sensitive_text("line one\nline two", Some(&el("Document", "Editor"))).is_none());
        assert!(sensitive_text("hello", None).is_none());
    }

    #[test]
    fn a_tab_in_typed_text_counts_as_the_tab_key() {
        assert!(sensitive_text("alice\tsecret", Some(&el("Edit", "User name"))).is_some());
        assert!(sensitive_text("a\tb", None).is_some());
        assert!(sensitive_text("\tindented", Some(&el("Document", "Editor"))).is_none());
    }
}
