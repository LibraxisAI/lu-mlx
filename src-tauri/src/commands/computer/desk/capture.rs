//! From a raw capture to the image a model gets: blocked windows blacked out,
//! scaled so the longest edge fits, encoded.

use super::geometry::{fit_longest_edge, input_rect_to_image};
use super::types::{PlatformError, PlatformResult, Rect};
use image::{imageops::FilterType, ImageEncoder, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_EDGE: u32 = 1568;
pub const MIN_MAX_EDGE: u32 = 320;
pub const MAX_MAX_EDGE: u32 = 3840;
pub const DEFAULT_JPEG_QUALITY: u8 = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    #[default]
    Jpeg,
    Png,
}

impl ImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Png => "image/png",
        }
    }
}

pub fn clamp_max_edge(requested: Option<u32>) -> u32 {
    requested.unwrap_or(DEFAULT_MAX_EDGE).clamp(MIN_MAX_EDGE, MAX_MAX_EDGE)
}

/// Black out `hidden` (rectangles of the input space on `monitor`) and scale
/// the capture down. The rectangles are painted before scaling, so no
/// neighbouring pixel of a hidden window bleeds into the result.
pub fn prepare(mut capture: RgbaImage, monitor: &Rect, hidden: &[Rect], max_edge: u32) -> RgbaImage {
    let (width, height) = capture.dimensions();
    for rect in hidden {
        if let Some((x, y, w, h)) = input_rect_to_image(monitor, rect, width, height) {
            for py in y..(y + h).min(height) {
                for px in x..(x + w).min(width) {
                    capture.put_pixel(px, py, Rgba([0, 0, 0, 255]));
                }
            }
        }
    }
    let (target_w, target_h, factor) = fit_longest_edge(width, height, max_edge);
    if factor >= 1.0 {
        return capture;
    }
    image::imageops::resize(&capture, target_w, target_h, FilterType::Triangle)
}

/// Cells of the coarse part of a fingerprint, across and down.
const LOOK_COLUMNS: u32 = 32;
const LOOK_ROWS: u32 = 18;

/// What a picture looks like, small enough to compare two of them: the mean
/// brightness of each cell of a 32 by 18 grid as one hex digit, then a colon,
/// then a hash of every pixel. Two pictures with the same hash are the same
/// picture. Two with the same cells differ by a detail at most (a caret that
/// blinks, one digit of a clock). Whoever drives the screen tells from it
/// whether a step changed anything.
pub fn fingerprint(image: &RgbaImage) -> String {
    let (width, height) = image.dimensions();
    let mut sums = vec![0u64; (LOOK_COLUMNS * LOOK_ROWS) as usize];
    let mut counts = vec![0u64; (LOOK_COLUMNS * LOOK_ROWS) as usize];
    // FNV-1a, 64 bit.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (x, y, pixel) in image.enumerate_pixels() {
        let [r, g, b, _] = pixel.0;
        for byte in [r, g, b] {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        let column = (u64::from(x) * u64::from(LOOK_COLUMNS) / u64::from(width.max(1))) as usize;
        let row = (u64::from(y) * u64::from(LOOK_ROWS) / u64::from(height.max(1))) as usize;
        let cell = row * LOOK_COLUMNS as usize + column;
        sums[cell] += (u64::from(r) * 299 + u64::from(g) * 587 + u64::from(b) * 114) / 1000;
        counts[cell] += 1;
    }
    let mut out = String::with_capacity(sums.len() + 17);
    for (sum, count) in sums.iter().zip(&counts) {
        let level = if *count == 0 { 0 } else { (sum / count) / 16 };
        out.push(char::from_digit(level.min(15) as u32, 16).unwrap_or('0'));
    }
    out.push(':');
    out.push_str(&format!("{hash:016x}"));
    out
}

pub fn encode(image: &RgbaImage, format: ImageFormat, quality: u8) -> PlatformResult<Vec<u8>> {
    let mut out = Vec::new();
    let failed = |_| PlatformError::failed("The screenshot could not be encoded.");
    match format {
        ImageFormat::Png => image::codecs::png::PngEncoder::new(&mut out)
            .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8)
            .map_err(failed)?,
        ImageFormat::Jpeg => {
            // JPEG has no alpha channel.
            let rgb = image::DynamicImage::ImageRgba8(image.clone()).to_rgb8();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(30, 95))
                .write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
                .map_err(failed)?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grey(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba([200, 200, 200, 255]))
    }

    #[test]
    fn scales_the_longest_edge_and_keeps_small_captures() {
        let monitor = Rect::new(0, 0, 3840, 2160);
        let image = prepare(grey(3840, 2160), &monitor, &[], 1568);
        assert_eq!(image.dimensions(), (1568, 882));
        let small = prepare(grey(1280, 720), &Rect::new(0, 0, 1280, 720), &[], 1568);
        assert_eq!(small.dimensions(), (1280, 720));
    }

    #[test]
    fn hidden_windows_are_black_and_the_rest_is_untouched() {
        let monitor = Rect::new(-1920, 0, 1920, 1080);
        let image = prepare(grey(1920, 1080), &monitor, &[Rect::new(-1920, 0, 960, 1080)], 960);
        assert_eq!(image.dimensions(), (960, 540));
        assert_eq!(image.get_pixel(10, 10), &Rgba([0, 0, 0, 255]));
        assert_eq!(image.get_pixel(470, 500), &Rgba([0, 0, 0, 255]));
        assert_eq!(image.get_pixel(900, 500), &Rgba([200, 200, 200, 255]));
    }

    #[test]
    fn a_retina_capture_is_hidden_in_pixels_not_points() {
        // macOS: the monitor is 1440x900 points, the capture 2880x1800 pixels.
        let monitor = Rect::new(0, 0, 1440, 900);
        let image = prepare(grey(2880, 1800), &monitor, &[Rect::new(720, 0, 720, 900)], 4000);
        assert_eq!(image.get_pixel(2000, 900), &Rgba([0, 0, 0, 255]));
        assert_eq!(image.get_pixel(1000, 900), &Rgba([200, 200, 200, 255]));
    }

    #[test]
    fn a_fingerprint_tells_the_same_picture_a_detail_and_a_new_screen_apart() {
        let plain = grey(640, 360);
        let same = fingerprint(&plain);
        assert_eq!(same, fingerprint(&grey(640, 360)));
        assert_eq!(same.len(), 32 * 18 + 1 + 16);

        // One small mark, the size of a caret: the cells stay, the hash moves.
        let mut caret = grey(640, 360);
        for y in 100..112 {
            caret.put_pixel(300, y, Rgba([0, 0, 0, 255]));
        }
        let detail = fingerprint(&caret);
        assert_eq!(detail.split(':').next(), same.split(':').next());
        assert_ne!(detail, same);

        // A window that opens: the cells move.
        let mut opened = grey(640, 360);
        for y in 60..300 {
            for x in 100..500 {
                opened.put_pixel(x, y, Rgba([20, 20, 20, 255]));
            }
        }
        assert_ne!(fingerprint(&opened).split(':').next(), same.split(':').next());
    }

    #[test]
    fn encodes_png_and_jpeg() {
        let image = grey(64, 48);
        let png = encode(&image, ImageFormat::Png, 80).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let jpeg = encode(&image, ImageFormat::Jpeg, 80).unwrap();
        assert_eq!(&jpeg[..3], &[0xFF, 0xD8, 0xFF]);
        assert_eq!(ImageFormat::Jpeg.mime(), "image/jpeg");
    }

    #[test]
    fn max_edge_is_clamped() {
        assert_eq!(clamp_max_edge(None), 1568);
        assert_eq!(clamp_max_edge(Some(1)), MIN_MAX_EDGE);
        assert_eq!(clamp_max_edge(Some(100_000)), MAX_MAX_EDGE);
    }
}
