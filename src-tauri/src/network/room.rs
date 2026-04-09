use std::net::Ipv4Addr;

/// Resolve the first non-loopback LAN IPv4 address.
pub fn get_lan_ip() -> Result<Ipv4Addr, String> {
	match local_ip_address::local_ip() {
		Ok(std::net::IpAddr::V4(ip)) => Ok(ip),
		Ok(std::net::IpAddr::V6(_)) => Err("Only IPv4 LAN addresses are supported".into()),
		Err(e) => Err(format!("Failed to resolve LAN IP: {e}")),
	}
}

/// Encode an IPv4 address and port into a short room code (e.g. `XXXX-XXXX-XX`).
///
/// Layout: 4 bytes IP + 2 bytes port (big-endian) → 6-byte integer → base-36 →
/// zero-padded to 10 chars → dashes inserted as `XXXX-XXXX-XX`.
pub fn encode_room_code(ip: Ipv4Addr, port: u16) -> String {
	let octets = ip.octets();
	let value: u64 = ((octets[0] as u64) << 40)
		| ((octets[1] as u64) << 32)
		| ((octets[2] as u64) << 24)
		| ((octets[3] as u64) << 16)
		| (port as u64);

	let encoded = to_base36(value);

	// Zero-pad to 10 characters (max value 2^48-1 = 281_474_976_710_655 fits in 10 base-36 digits)
	let padded = format!("{:0>10}", encoded);

	// Insert dashes: XXXX-XXXX-XX
	format!("{}-{}-{}", &padded[..4], &padded[4..8], &padded[8..10])
}

/// Decode a room code back into an IPv4 address and port.
pub fn decode_room_code(code: &str) -> Result<(Ipv4Addr, u16), String> {
	let stripped: String = code.chars().filter(|c| *c != '-' && !c.is_whitespace()).collect();

	if stripped.len() != 10 {
		return Err(format!("Invalid room code length: expected 10 characters, got {}", stripped.len()));
	}

	let value = from_base36(&stripped)?;

	// Max valid value: 255.255.255.255:65535
	if value > 0xFFFF_FFFF_FFFF {
		return Err("Room code value out of range".into());
	}

	let port = (value & 0xFFFF) as u16;
	let ip_raw = (value >> 16) as u32;
	let ip = Ipv4Addr::new(
		((ip_raw >> 24) & 0xFF) as u8,
		((ip_raw >> 16) & 0xFF) as u8,
		((ip_raw >> 8) & 0xFF) as u8,
		(ip_raw & 0xFF) as u8,
	);

	Ok((ip, port))
}

const BASE36_CHARS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

fn to_base36(mut value: u64) -> String {
	if value == 0 {
		return "0".into();
	}
	let mut digits = Vec::new();
	while value > 0 {
		digits.push(BASE36_CHARS[(value % 36) as usize]);
		value /= 36;
	}
	digits.reverse();
	String::from_utf8(digits).unwrap()
}

fn from_base36(s: &str) -> Result<u64, String> {
	let mut value: u64 = 0;
	for ch in s.chars() {
		let digit = match ch {
			'0'..='9' => (ch as u64) - ('0' as u64),
			'A'..='Z' => (ch as u64) - ('A' as u64) + 10,
			'a'..='z' => (ch as u64) - ('a' as u64) + 10,
			_ => return Err(format!("Invalid character in room code: '{ch}'")),
		};
		value = value
			.checked_mul(36)
			.and_then(|v| v.checked_add(digit))
			.ok_or("Room code value overflow")?;
	}
	Ok(value)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn roundtrip_common_lan() {
		let ip = Ipv4Addr::new(192, 168, 1, 42);
		let port = 54321;
		let code = encode_room_code(ip, port);
		let (decoded_ip, decoded_port) = decode_room_code(&code).unwrap();
		assert_eq!(decoded_ip, ip);
		assert_eq!(decoded_port, port);
	}

	#[test]
	fn roundtrip_10_network() {
		let ip = Ipv4Addr::new(10, 0, 0, 1);
		let port = 8080;
		let code = encode_room_code(ip, port);
		let (decoded_ip, decoded_port) = decode_room_code(&code).unwrap();
		assert_eq!(decoded_ip, ip);
		assert_eq!(decoded_port, port);
	}

	#[test]
	fn roundtrip_max_values() {
		let ip = Ipv4Addr::new(255, 255, 255, 255);
		let port = 65535;
		let code = encode_room_code(ip, port);
		let (decoded_ip, decoded_port) = decode_room_code(&code).unwrap();
		assert_eq!(decoded_ip, ip);
		assert_eq!(decoded_port, port);
	}

	#[test]
	fn roundtrip_min_values() {
		let ip = Ipv4Addr::new(0, 0, 0, 0);
		let port = 0;
		let code = encode_room_code(ip, port);
		let (decoded_ip, decoded_port) = decode_room_code(&code).unwrap();
		assert_eq!(decoded_ip, ip);
		assert_eq!(decoded_port, port);
	}

	#[test]
	fn code_format() {
		let code = encode_room_code(Ipv4Addr::new(192, 168, 1, 42), 54321);
		// Should be XXXX-XXXX-XX format
		let parts: Vec<&str> = code.split('-').collect();
		assert_eq!(parts.len(), 3);
		assert_eq!(parts[0].len(), 4);
		assert_eq!(parts[1].len(), 4);
		assert_eq!(parts[2].len(), 2);
	}

	#[test]
	fn case_insensitive_decode() {
		let code = encode_room_code(Ipv4Addr::new(192, 168, 1, 42), 54321);
		let lower = code.to_lowercase();
		let (ip, port) = decode_room_code(&lower).unwrap();
		assert_eq!(ip, Ipv4Addr::new(192, 168, 1, 42));
		assert_eq!(port, 54321);
	}

	#[test]
	fn decode_without_dashes() {
		let code = encode_room_code(Ipv4Addr::new(192, 168, 1, 42), 54321);
		let no_dashes: String = code.chars().filter(|c| *c != '-').collect();
		let (ip, port) = decode_room_code(&no_dashes).unwrap();
		assert_eq!(ip, Ipv4Addr::new(192, 168, 1, 42));
		assert_eq!(port, 54321);
	}

	#[test]
	fn invalid_length() {
		assert!(decode_room_code("ABC").is_err());
		assert!(decode_room_code("ABCDEFGHIJKLM").is_err());
	}

	#[test]
	fn invalid_characters() {
		assert!(decode_room_code("XXXX-!@#$-XX").is_err());
	}
}
