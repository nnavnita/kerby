//! Shared helpers for opaque, high-entropy tokens (refresh tokens, password
//! reset/verify tokens). Not JWTs — random strings, stored hashed.

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Two concatenated UUIDv4s (~244 bits of CSPRNG randomness) — reuses the
/// `uuid` crate already in the dependency tree instead of adding one purely
/// for random-byte generation.
pub fn generate_opaque_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// SHA-256 hex digest. These tokens are high-entropy random strings, not
/// user-chosen secrets, so a fast cryptographic hash is the right tool —
/// unlike passwords, they don't need Argon2's deliberate slowness.
pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_opaque_token_is_unique_and_64_hex_chars() {
        let a = generate_opaque_token();
        let b = generate_opaque_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64); // two UUIDv4 "simple" (no-hyphen) forms, 32 hex chars each
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn hash_token_is_deterministic_and_64_hex_chars() {
        let token = generate_opaque_token();
        let h1 = hash_token(&token);
        let h2 = hash_token(&token);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // SHA-256 hex digest
        assert_ne!(h1, token);
    }
}
