//! Cutting an accessibility tree down to what a model can use: the visible,
//! interactive elements, with a cap on depth and count, positions on the grid
//! of the current frame, and names that are short and free of control
//! characters.

use super::geometry::rect_to_grid;
use super::types::{RawNode, Rect, UiNode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeLimits {
    pub max_depth: u32,
    pub max_nodes: usize,
}

impl TreeLimits {
    pub const DEFAULT: TreeLimits = TreeLimits { max_depth: 14, max_nodes: 150 };
    pub const HARD_MAX_NODES: usize = 400;
    pub const HARD_MAX_DEPTH: u32 = 30;

    pub fn clamped(max_depth: Option<u32>, max_nodes: Option<usize>) -> TreeLimits {
        TreeLimits {
            max_depth: max_depth.unwrap_or(Self::DEFAULT.max_depth).clamp(1, Self::HARD_MAX_DEPTH),
            max_nodes: max_nodes.unwrap_or(Self::DEFAULT.max_nodes).clamp(1, Self::HARD_MAX_NODES),
        }
    }
}

pub const MAX_NAME_CHARS: usize = 80;

const INTERACTIVE: &[&str] = &[
    "button", "checkbox", "combobox", "edit", "hyperlink", "listitem", "menuitem", "radiobutton", "slider",
    "spinner", "splitbutton", "tabitem", "treeitem", "dataitem", "menubar", "togglebutton", "link", "textfield",
];

pub fn is_interactive(role: &str) -> bool {
    let normalized: String = role.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    INTERACTIVE.contains(&normalized.as_str())
}

/// One line, no control characters, at most [`MAX_NAME_CHARS`] characters.
pub fn clean_name(name: &str) -> String {
    let folded: String = name
        .chars()
        .map(|c| if c.is_control() || c == '\u{2028}' || c == '\u{2029}' { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if folded.chars().count() <= MAX_NAME_CHARS {
        return folded;
    }
    let mut short: String = folded.chars().take(MAX_NAME_CHARS - 3).collect();
    short.push_str("...");
    short
}

#[derive(Debug, Clone, PartialEq)]
pub struct PrunedTree {
    pub nodes: Vec<UiNode>,
    /// Elements that qualified but did not fit the cap.
    pub dropped: usize,
    /// A password field holds the keyboard focus.
    pub password_focused: bool,
}

/// `raw` is the tree in pre-order. `monitor` is the monitor of the current
/// frame in the input space; elements that do not touch it are left out.
pub fn prune(raw: &[RawNode], monitor: &Rect, limits: TreeLimits) -> PrunedTree {
    let mut nodes = Vec::new();
    let mut dropped = 0;
    let mut password_focused = false;
    for node in raw {
        if node.password && node.focused {
            password_focused = true;
        }
        if node.depth > limits.max_depth || node.offscreen || node.rect.is_empty() || !is_interactive(&node.role) {
            continue;
        }
        let Some(rect) = rect_to_grid(monitor, &node.rect) else { continue };
        let name = clean_name(&node.name);
        // An unnamed element tells the model nothing it can act on, except a
        // text field, which is still a place to type.
        if name.is_empty() && !matches!(node.role.to_lowercase().as_str(), "edit" | "combobox") {
            continue;
        }
        if nodes.len() >= limits.max_nodes {
            dropped += 1;
            continue;
        }
        nodes.push(UiNode {
            depth: node.depth,
            role: node.role.clone(),
            name,
            rect,
            enabled: node.enabled,
            focused: node.focused,
            password: node.password,
            state: node.state.clone(),
            value: if node.password { None } else { node.value.as_deref().map(clean_name).filter(|v| !v.is_empty()) },
        });
    }
    PrunedTree { nodes, dropped, password_focused }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: Rect = Rect::new(0, 0, 2000, 1000);

    fn node(depth: u32, role: &str, name: &str, rect: Rect) -> RawNode {
        RawNode { depth, role: role.into(), name: name.into(), rect, enabled: true, ..Default::default() }
    }

    #[test]
    fn keeps_interactive_visible_elements_on_the_grid() {
        let raw = vec![
            node(0, "Window", "Editor", Rect::new(0, 0, 2000, 1000)),
            node(1, "Pane", "", Rect::new(0, 0, 2000, 1000)),
            node(2, "Button", "Save", Rect::new(1000, 500, 200, 100)),
            node(2, "Text", "Just a label", Rect::new(0, 0, 100, 20)),
            node(2, "Edit", "", Rect::new(0, 900, 2000, 100)),
        ];
        let pruned = prune(&raw, &MONITOR, TreeLimits::DEFAULT);
        assert_eq!(pruned.nodes.len(), 2);
        assert_eq!(pruned.nodes[0].name, "Save");
        assert_eq!(pruned.nodes[0].rect, [500, 501, 600, 600]);
        assert_eq!(pruned.nodes[1].role, "Edit");
        assert_eq!(pruned.dropped, 0);
    }

    #[test]
    fn drops_offscreen_empty_unnamed_and_foreign_monitor_elements() {
        let mut hidden = node(1, "Button", "Hidden", Rect::new(0, 0, 10, 10));
        hidden.offscreen = true;
        let raw = vec![
            hidden,
            node(1, "Button", "Empty", Rect::new(0, 0, 0, 0)),
            node(1, "Button", "", Rect::new(0, 0, 10, 10)),
            node(1, "Button", "Elsewhere", Rect::new(5000, 0, 10, 10)),
        ];
        assert!(prune(&raw, &MONITOR, TreeLimits::DEFAULT).nodes.is_empty());
    }

    #[test]
    fn caps_depth_and_count_and_reports_what_did_not_fit() {
        let raw: Vec<RawNode> = (0..500).map(|i| node(1 + (i % 3), "Button", &format!("B{i}"), Rect::new(0, 0, 10, 10))).collect();
        let pruned = prune(&raw, &MONITOR, TreeLimits { max_depth: 2, max_nodes: 50 });
        assert_eq!(pruned.nodes.len(), 50);
        assert!(pruned.nodes.iter().all(|n| n.depth <= 2));
        // 500 buttons, a third of them too deep: 334 qualify, 50 fit.
        assert_eq!(pruned.dropped, 334 - 50);
    }

    #[test]
    fn limits_are_clamped() {
        assert_eq!(TreeLimits::clamped(None, None), TreeLimits::DEFAULT);
        assert_eq!(TreeLimits::clamped(Some(0), Some(0)), TreeLimits { max_depth: 1, max_nodes: 1 });
        assert_eq!(
            TreeLimits::clamped(Some(9999), Some(usize::MAX)),
            TreeLimits { max_depth: TreeLimits::HARD_MAX_DEPTH, max_nodes: TreeLimits::HARD_MAX_NODES }
        );
    }

    #[test]
    fn names_are_one_short_line() {
        assert_eq!(clean_name("  Save\r\n\tall \u{0007} files "), "Save all files");
        let long = clean_name(&"x".repeat(500));
        assert_eq!(long.chars().count(), MAX_NAME_CHARS);
        assert!(long.ends_with("..."));
        assert_eq!(clean_name("Grüße 你好"), "Grüße 你好");
    }

    #[test]
    fn a_focused_password_field_is_reported_even_when_it_is_pruned_away() {
        let mut field = node(40, "Edit", "Password", Rect::new(0, 0, 100, 20));
        field.password = true;
        field.focused = true;
        let pruned = prune(&[field], &MONITOR, TreeLimits::DEFAULT);
        assert!(pruned.password_focused);
        assert!(pruned.nodes.is_empty());
    }

    #[test]
    fn roles_are_matched_loosely() {
        assert!(is_interactive("Button"));
        assert!(is_interactive("ListItem"));
        assert!(is_interactive("Tab Item"));
        assert!(!is_interactive("Pane"));
        assert!(!is_interactive("Text"));
    }
}
