//! JSON text byte-identical to Python's `json.dumps` (float repr, ensure_ascii, separators, indent).

use serde_json::{Map, Value};
use std::fmt::Write;

#[derive(Clone, Copy)]
pub enum Style {
    Default,
    Compact,
    Indent(usize),
}

pub fn dumps(v: &Value, style: Style, sort_keys: bool) -> String {
    let mut out = String::new();
    write_value(&mut out, v, style, sort_keys, 0);
    out
}

pub fn write(path: &std::path::Path, v: &Value, style: Style, sort_keys: bool) -> std::io::Result<()> {
    std::fs::write(path, dumps(v, style, sort_keys))
}

pub fn float(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let shortest = format!("{x:e}");
    let n = shortest.split_once('e').map_or(0, |(m, _)| m.chars().filter(char::is_ascii_digit).count());
    // Python picks the closest round-tripping string of that length (ties to even)
    let exact = format!("{:.*e}", n.saturating_sub(1), x);
    let e = if exact.parse::<f64>().ok() == Some(x) { exact } else { shortest };
    let (mant, exp) = e.split_once('e').expect("LowerExp has an exponent");
    let exp: i32 = exp.parse().expect("exponent");
    let neg = mant.starts_with('-');
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    if (-4..16).contains(&exp) {
        if exp >= 0 {
            let int_len = exp as usize + 1;
            if digits.len() <= int_len {
                s.push_str(&digits);
                s.extend(std::iter::repeat_n('0', int_len - digits.len()));
                s.push_str(".0");
            } else {
                s.push_str(&digits[..int_len]);
                s.push('.');
                s.push_str(&digits[int_len..]);
            }
        } else {
            s.push_str("0.");
            s.extend(std::iter::repeat_n('0', (-exp - 1) as usize));
            s.push_str(&digits);
        }
    } else {
        s.push_str(&digits[..1]);
        if digits.len() > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        let _ = write!(s, "e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs());
    }
    s
}

/// Python's `round(x, 6)` for a float.
pub fn round6(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let r: f64 = format!("{x:.6}").parse().expect("formatted float");
    if r == 0.0 { 0.0f64.copysign(x) } else { r }
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    let _ = write!(out, "\\u{:04x}", u);
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn newline(out: &mut String, style: Style, depth: usize) {
    if let Style::Indent(n) = style {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', n * depth));
    }
}

fn item_sep(style: Style) -> &'static str {
    match style {
        Style::Default => ", ",
        _ => ",",
    }
}

fn key_sep(style: Style) -> &'static str {
    match style {
        Style::Compact => ":",
        _ => ": ",
    }
}

fn write_value(out: &mut String, v: &Value, style: Style, sort: bool, depth: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                let _ = write!(out, "{i}");
            } else if let Some(u) = n.as_u64() {
                let _ = write!(out, "{u}");
            } else {
                out.push_str(&float(n.as_f64().unwrap_or(f64::NAN)));
            }
        }
        Value::String(s) => write_str(out, s),
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep(style));
                }
                newline(out, style, depth + 1);
                write_value(out, x, style, sort, depth + 1);
            }
            newline(out, style, depth);
            out.push(']');
        }
        Value::Object(m) => write_map(out, m, style, sort, depth),
    }
}

fn write_map(out: &mut String, m: &Map<String, Value>, style: Style, sort: bool, depth: usize) {
    if m.is_empty() {
        out.push_str("{}");
        return;
    }
    let mut keys: Vec<&String> = m.keys().collect();
    if sort {
        keys.sort();
    }
    out.push('{');
    for (i, k) in keys.into_iter().enumerate() {
        if i > 0 {
            out.push_str(item_sep(style));
        }
        newline(out, style, depth + 1);
        write_str(out, k);
        out.push_str(key_sep(style));
        write_value(out, &m[k], style, sort, depth + 1);
    }
    newline(out, style, depth);
    out.push('}');
}

pub fn f(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

pub fn floats<I: IntoIterator<Item = f64>>(it: I) -> Value {
    Value::Array(it.into_iter().map(f).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repr() {
        assert_eq!(float(1.0 / 12.0), "0.08333333333333333");
        assert_eq!(float(1.0), "1.0");
        assert_eq!(float(-0.0), "-0.0");
        assert_eq!(float(1e-5), "1e-05");
        assert_eq!(float(0.0001), "0.0001");
        assert_eq!(float(1e16), "1e+16");
        assert_eq!(float(123456789012345.0), "123456789012345.0");
        assert_eq!(float(1.5e-7), "1.5e-07");
        assert_eq!(float(0.30000001192092896), "0.30000001192092896");
        assert_eq!(round6(0.1234565), 0.123456);
        assert_eq!(float(2f64.powi(-25)), "2.9802322387695312e-08");
        assert_eq!(float(2f64.powi(-24)), "5.960464477539063e-08");
    }
}
