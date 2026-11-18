//! The non-overlapping length-prefixed ASCII string fields of a .binfab prefab.

fn read_uleb(data: &[u8], mut pos: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        let b = *data.get(pos)?;
        pos += 1;
        result |= u64::from(b & 0x7f).checked_shl(shift).unwrap_or(0);
        if b & 0x80 == 0 {
            return Some((result, pos));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// Every `<key wt8><uleb len><printable bytes>` at any offset, minus phantoms inside the previous field.
pub fn real_fields(data: &[u8]) -> Vec<(usize, u64, &str)> {
    let mut out = Vec::new();
    let n = data.len();
    let mut last_end: i64 = -1;
    for i in 0..n.saturating_sub(1) {
        let Some((key, j)) = read_uleb(data, i) else { continue };
        if key & 0xf != 8 {
            continue;
        }
        let Some((length, k)) = read_uleb(data, j) else { continue };
        if !(2..=512).contains(&length) || k + length as usize > n {
            continue;
        }
        let raw = &data[k..k + length as usize];
        if !raw.iter().all(|b| (32..127).contains(b)) {
            continue;
        }
        if k as i64 >= last_end {
            out.push((i, key >> 4, std::str::from_utf8(raw).expect("ascii")));
            last_end = (k + length as usize) as i64;
        }
    }
    out
}
