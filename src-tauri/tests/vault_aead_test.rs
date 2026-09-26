use ccie_terminal_lib::vault::aead::{open, seal, AeadError};
use zeroize::Zeroizing;

#[test]
fn seal_open_roundtrip() {
    let key = Zeroizing::new([7u8; 32]);
    let plaintext = b"hunter2-ssh-pw";
    let sealed = seal(&key, plaintext, b"envelope-x").unwrap();
    let opened = open(&key, &sealed, b"envelope-x").unwrap();
    let opened_slice: &[u8] = &opened;
    assert_eq!(opened_slice, plaintext);
}

#[test]
fn open_rejects_tampered_ciphertext() {
    let key = Zeroizing::new([7u8; 32]);
    let mut sealed = seal(&key, b"secret", b"env").unwrap();
    let last = sealed.len() - 1;
    sealed[last] ^= 0x01;
    let err = open(&key, &sealed, b"env").unwrap_err();
    assert!(matches!(err, AeadError::Decrypt));
}

#[test]
fn open_rejects_wrong_key() {
    let k1 = Zeroizing::new([7u8; 32]);
    let k2 = Zeroizing::new([8u8; 32]);
    let sealed = seal(&k1, b"secret", b"env").unwrap();
    assert!(matches!(open(&k2, &sealed, b"env").unwrap_err(), AeadError::Decrypt));
}

#[test]
fn open_rejects_wrong_aad() {
    let key = Zeroizing::new([7u8; 32]);
    let sealed = seal(&key, b"secret", b"env-a").unwrap();
    assert!(matches!(open(&key, &sealed, b"env-b").unwrap_err(), AeadError::Decrypt));
}

#[test]
fn nonce_randomization_yields_distinct_ciphertexts() {
    let key = Zeroizing::new([3u8; 32]);
    let a = seal(&key, b"same", b"aad").unwrap();
    let b = seal(&key, b"same", b"aad").unwrap();
    assert_ne!(a, b, "two seals of same plaintext must differ (random nonce)");
}

#[test]
fn open_rejects_truncated_envelope() {
    let key = Zeroizing::new([1u8; 32]);
    let bad = vec![0u8; 10];
    assert!(matches!(open(&key, &bad, b"aad").unwrap_err(), AeadError::Malformed));
}
