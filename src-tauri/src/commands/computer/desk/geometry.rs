//! Coordinate math of computer use, pure and tested.
//!
//! Three spaces meet here:
//!   * the model's grid, 0..=1000 on both axes, relative to the monitor of the
//!     last frame;
//!   * the input space of the platform (physical pixels on Windows and X11,
//!     points on macOS), where monitors have an origin that can be negative;
//!   * the pixels of the captured image, which is the monitor scaled down so
//!     its longest edge fits a model.
//!
//! The classic Windows mistake is to mix logical and physical pixels on a
//! display scaled to 125 or 150 percent, or to treat the primary monitor as
//! the whole desktop. LU avoids the first by never holding a logical value:
//! the Windows adapter works on a per-monitor DPI aware thread, so every
//! number it reads or sends is a physical pixel and nothing is converted by
//! a scale factor. The second is the virtual desktop mapping below.

use super::types::Rect;

pub const GRID_MAX: i32 = 1000;

/// Grid position to a point of the input space on `monitor`.
///
/// 0 is the first pixel and 1000 the last, so both edges are reachable and no
/// value can leave the monitor. Returns `None` for a value outside the grid or
/// an empty monitor.
pub fn grid_to_input(monitor: &Rect, gx: i32, gy: i32) -> Option<(i32, i32)> {
    if monitor.is_empty() || !(0..=GRID_MAX).contains(&gx) || !(0..=GRID_MAX).contains(&gy) {
        return None;
    }
    Some((monitor.x + axis_to_input(gx, monitor.width), monitor.y + axis_to_input(gy, monitor.height)))
}

fn axis_to_input(g: i32, extent: i32) -> i32 {
    // Rounded to the nearest pixel of a span that is extent - 1 long.
    let span = i64::from(extent - 1);
    ((i64::from(g) * span + i64::from(GRID_MAX) / 2) / i64::from(GRID_MAX)) as i32
}

/// A point of the input space to the grid of `monitor`, clamped to it.
pub fn input_to_grid(monitor: &Rect, x: i32, y: i32) -> Option<(i32, i32)> {
    if monitor.is_empty() {
        return None;
    }
    Some((axis_to_grid(x - monitor.x, monitor.width), axis_to_grid(y - monitor.y, monitor.height)))
}

fn axis_to_grid(offset: i32, extent: i32) -> i32 {
    if extent <= 1 {
        return 0;
    }
    let span = i64::from(extent - 1);
    let clamped = i64::from(offset).clamp(0, span);
    ((clamped * i64::from(GRID_MAX) + span / 2) / span) as i32
}

/// A rectangle of the input space as `[left, top, right, bottom]` on the grid
/// of `monitor`. `None` when nothing of it lies on the monitor.
pub fn rect_to_grid(monitor: &Rect, rect: &Rect) -> Option<[i32; 4]> {
    let visible = monitor.intersect(rect)?;
    let (left, top) = input_to_grid(monitor, visible.x, visible.y)?;
    let (right, bottom) = input_to_grid(monitor, visible.right() - 1, visible.bottom() - 1)?;
    Some([left, top, right, bottom])
}

/// Size of the image for the model: the capture scaled so its longest edge is
/// at most `max_edge`. Never scales up. The returned factor is image pixels
/// per captured pixel.
pub fn fit_longest_edge(width: u32, height: u32, max_edge: u32) -> (u32, u32, f64) {
    let longest = width.max(height);
    if longest == 0 || max_edge == 0 || longest <= max_edge {
        return (width, height, 1.0);
    }
    let factor = f64::from(max_edge) / f64::from(longest);
    let scale = |v: u32| ((f64::from(v) * factor).round() as u32).max(1);
    (scale(width), scale(height), factor)
}

/// The bounding box of all monitors: the Windows virtual desktop.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn virtual_desktop(monitors: &[Rect]) -> Option<Rect> {
    let mut iter = monitors.iter().filter(|m| !m.is_empty());
    let first = *iter.next()?;
    let (mut left, mut top, mut right, mut bottom) = (first.x, first.y, first.right(), first.bottom());
    for m in iter {
        left = left.min(m.x);
        top = top.min(m.y);
        right = right.max(m.right());
        bottom = bottom.max(m.bottom());
    }
    Some(Rect::new(left, top, right - left, bottom - top))
}

/// A physical point to the 0..=65535 range `SendInput` wants together with
/// `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`. Without the virtual desk
/// flag and this mapping, an absolute move can only reach the primary monitor.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn to_absolute_65535(virtual_desk: &Rect, x: i32, y: i32) -> Option<(i32, i32)> {
    if virtual_desk.is_empty() {
        return None;
    }
    let norm = |value: i32, origin: i32, extent: i32| -> i32 {
        let span = i64::from((extent - 1).max(1));
        let offset = i64::from(value - origin).clamp(0, span);
        // Round to nearest: Windows maps the range back by truncating, so a
        // plain floor here lands one pixel short on many positions.
        ((offset * 65535 + span / 2) / span) as i32
    };
    Some((norm(x, virtual_desk.x, virtual_desk.width), norm(y, virtual_desk.y, virtual_desk.height)))
}

/// `base` without the part `cut` covers, as up to four rectangles.
pub fn subtract(base: &Rect, cut: &Rect) -> Vec<Rect> {
    let Some(hit) = base.intersect(cut) else {
        return if base.is_empty() { Vec::new() } else { vec![*base] };
    };
    let mut out = Vec::with_capacity(4);
    if hit.y > base.y {
        out.push(Rect::new(base.x, base.y, base.width, hit.y - base.y));
    }
    if hit.bottom() < base.bottom() {
        out.push(Rect::new(base.x, hit.bottom(), base.width, base.bottom() - hit.bottom()));
    }
    if hit.x > base.x {
        out.push(Rect::new(base.x, hit.y, hit.x - base.x, hit.height));
    }
    if hit.right() < base.right() {
        out.push(Rect::new(hit.right(), hit.y, base.right() - hit.right(), hit.height));
    }
    out
}

/// The parts of `target` that are not covered by any of `above`.
pub fn visible_parts(target: &Rect, above: &[Rect]) -> Vec<Rect> {
    let mut parts = if target.is_empty() { Vec::new() } else { vec![*target] };
    for cover in above {
        if parts.is_empty() {
            break;
        }
        parts = parts.iter().flat_map(|p| subtract(p, cover)).collect();
    }
    parts
}

/// A rectangle of the input space to pixel bounds `(x, y, width, height)` of
/// an image that shows `monitor` at `image_width` x `image_height`. Grows
/// outward by one pixel so a blacked out area never leaves a readable seam.
pub fn input_rect_to_image(monitor: &Rect, rect: &Rect, image_width: u32, image_height: u32) -> Option<(u32, u32, u32, u32)> {
    let visible = monitor.intersect(rect)?;
    if image_width == 0 || image_height == 0 {
        return None;
    }
    let fx = f64::from(image_width) / f64::from(monitor.width);
    let fy = f64::from(image_height) / f64::from(monitor.height);
    let left = ((f64::from(visible.x - monitor.x) * fx).floor() as i64 - 1).max(0);
    let top = ((f64::from(visible.y - monitor.y) * fy).floor() as i64 - 1).max(0);
    let right = ((f64::from(visible.right() - monitor.x) * fx).ceil() as i64 + 1).min(i64::from(image_width));
    let bottom = ((f64::from(visible.bottom() - monitor.y) * fy).ceil() as i64 + 1).min(i64::from(image_height));
    (right > left && bottom > top).then(|| (left as u32, top as u32, (right - left) as u32, (bottom - top) as u32))
}

pub fn distance(a: (i32, i32), b: (i32, i32)) -> f64 {
    let dx = f64::from(a.0) - f64::from(b.0);
    let dy = f64::from(a.1) - f64::from(b.1);
    (dx * dx + dy * dy).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FHD: Rect = Rect::new(0, 0, 1920, 1080);

    #[test]
    fn grid_reaches_both_edges_and_never_leaves_the_monitor() {
        assert_eq!(grid_to_input(&FHD, 0, 0), Some((0, 0)));
        assert_eq!(grid_to_input(&FHD, 1000, 1000), Some((1919, 1079)));
        assert_eq!(grid_to_input(&FHD, 500, 500), Some((960, 540)));
        for g in 0..=GRID_MAX {
            let (x, y) = grid_to_input(&FHD, g, g).unwrap();
            assert!(FHD.contains(x, y), "grid {g} left the monitor at {x},{y}");
        }
    }

    #[test]
    fn grid_rejects_values_outside_the_grid() {
        assert_eq!(grid_to_input(&FHD, -1, 10), None);
        assert_eq!(grid_to_input(&FHD, 10, 1001), None);
        assert_eq!(grid_to_input(&Rect::new(0, 0, 0, 1080), 10, 10), None);
    }

    #[test]
    fn grid_on_a_monitor_left_of_and_above_the_primary() {
        // A 2560x1440 display to the left, top aligned 200 px above.
        let left = Rect::new(-2560, -200, 2560, 1440);
        assert_eq!(grid_to_input(&left, 0, 0), Some((-2560, -200)));
        assert_eq!(grid_to_input(&left, 1000, 1000), Some((-1, 1239)));
        let (x, y) = grid_to_input(&left, 500, 500).unwrap();
        assert!(left.contains(x, y));
        assert_eq!(input_to_grid(&left, x, y), Some((500, 500)));
    }

    #[test]
    fn grid_on_a_scaled_display_uses_physical_pixels() {
        // 4K at 150 percent: the input space on Windows is 3840x2160, not the
        // 2560x1440 a DPI unaware process would be told.
        let uhd = Rect::new(1920, 0, 3840, 2160);
        assert_eq!(grid_to_input(&uhd, 1000, 1000), Some((1920 + 3839, 2159)));
        assert_eq!(grid_to_input(&uhd, 250, 750), Some((1920 + 960, 1619)));
    }

    #[test]
    fn grid_round_trips_within_one_step() {
        for monitor in [FHD, Rect::new(-1280, 0, 1280, 1024), Rect::new(0, 0, 3440, 1440)] {
            for g in (0..=GRID_MAX).step_by(7) {
                let (x, y) = grid_to_input(&monitor, g, g).unwrap();
                let (bx, by) = input_to_grid(&monitor, x, y).unwrap();
                assert!((bx - g).abs() <= 1 && (by - g).abs() <= 1, "{monitor:?} {g} came back as {bx},{by}");
            }
        }
    }

    #[test]
    fn input_to_grid_clamps_points_outside() {
        assert_eq!(input_to_grid(&FHD, -50, 5000), Some((0, 1000)));
    }

    #[test]
    fn rect_to_grid_clips_to_the_monitor() {
        assert_eq!(rect_to_grid(&FHD, &Rect::new(960, 540, 192, 108)), Some([500, 500, 600, 600]));
        // Half off the left edge.
        assert_eq!(rect_to_grid(&FHD, &Rect::new(-100, 0, 200, 1080)).map(|r| (r[0], r[2])), Some((0, 52)));
        // On another monitor entirely.
        assert_eq!(rect_to_grid(&FHD, &Rect::new(2000, 0, 100, 100)), None);
    }

    #[test]
    fn longest_edge_fits_and_never_scales_up() {
        assert_eq!(fit_longest_edge(1920, 1080, 1568), (1568, 882, 1568.0 / 1920.0));
        assert_eq!(fit_longest_edge(1280, 720, 1568), (1280, 720, 1.0));
        let (w, h, _) = fit_longest_edge(1440, 3440, 1568);
        assert_eq!((w, h), (656, 1568));
        assert_eq!(fit_longest_edge(3840, 2160, 1568).0, 1568);
        assert_eq!(fit_longest_edge(0, 0, 1568), (0, 0, 1.0));
    }

    #[test]
    fn virtual_desktop_spans_all_monitors() {
        let monitors = [FHD, Rect::new(-2560, -200, 2560, 1440), Rect::new(1920, 0, 3840, 2160)];
        assert_eq!(virtual_desktop(&monitors), Some(Rect::new(-2560, -200, 8320, 2360)));
        assert_eq!(virtual_desktop(&[]), None);
    }

    #[test]
    fn absolute_mapping_covers_the_virtual_desk() {
        let desk = Rect::new(-2560, -200, 8320, 2360);
        assert_eq!(to_absolute_65535(&desk, -2560, -200), Some((0, 0)));
        assert_eq!(to_absolute_65535(&desk, 5759, 2159), Some((65535, 65535)));
        // The origin of the primary monitor is not zero in this space.
        let (x, y) = to_absolute_65535(&desk, 0, 0).unwrap();
        assert!(x > 20000 && y > 5000, "primary origin mapped to {x},{y}");
    }

    #[test]
    fn absolute_mapping_lands_on_the_same_pixel_again() {
        // Windows turns the value back with pixel = value * (extent - 1) / 65535.
        let desk = Rect::new(-1920, 0, 5760, 2160);
        for x in (-1920..3840).step_by(13) {
            let (nx, _) = to_absolute_65535(&desk, x, 0).unwrap();
            let back = (i64::from(nx) * i64::from(desk.width - 1) + 32767) / 65535 + i64::from(desk.x);
            assert_eq!(back, i64::from(x), "{x} came back as {back}");
        }
    }

    #[test]
    fn subtract_cuts_a_hole() {
        let base = Rect::new(0, 0, 100, 100);
        let parts = subtract(&base, &Rect::new(25, 25, 50, 50));
        assert_eq!(parts.len(), 4);
        let area: i32 = parts.iter().map(|p| p.width * p.height).sum();
        assert_eq!(area, 100 * 100 - 50 * 50);
        assert_eq!(subtract(&base, &Rect::new(200, 200, 5, 5)), vec![base]);
        assert!(subtract(&base, &Rect::new(-5, -5, 500, 500)).is_empty());
    }

    #[test]
    fn visible_parts_follow_the_stacking() {
        let terminal = Rect::new(0, 0, 800, 600);
        // Fully covered by a maximized window: nothing to hide.
        assert!(visible_parts(&terminal, &[FHD]).is_empty());
        // Half covered.
        let parts = visible_parts(&terminal, &[Rect::new(400, 0, 1000, 1080)]);
        assert_eq!(parts, vec![Rect::new(0, 0, 400, 600)]);
        assert_eq!(visible_parts(&terminal, &[]), vec![terminal]);
    }

    #[test]
    fn image_bounds_follow_the_downscale_and_grow_by_a_pixel() {
        // 1920x1080 shown at 960x540.
        let b = input_rect_to_image(&FHD, &Rect::new(200, 100, 400, 200), 960, 540).unwrap();
        assert_eq!(b, (99, 49, 202, 102));
        // On a monitor with a negative origin.
        let left = Rect::new(-1920, 0, 1920, 1080);
        let b = input_rect_to_image(&left, &Rect::new(-1920, 0, 1920, 1080), 960, 540).unwrap();
        assert_eq!(b, (0, 0, 960, 540));
        assert_eq!(input_rect_to_image(&FHD, &Rect::new(5000, 0, 10, 10), 960, 540), None);
    }
}
