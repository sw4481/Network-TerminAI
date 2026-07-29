use ccie_terminal_lib::vault::kdf::{derive_key, KdfParams};
use zeroize::Zeroizing;

#[test]
fn derive_key_is_deterministic_for_same_inputs() {
    let params = KdfParams::default();
    let salt = [0u8; 16];
    let k1 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &salt, &params).unwrap();
    let k2 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &salt, &params).unwrap();
    assert_eq!(k1.as_ref(), k2.as_ref());
    assert_eq!(k1.as_ref().len(), 32);
}

#[test]
fn derive_key_differs_with_different_salt() {
    let params = KdfParams::default();
    let s1 = [0u8; 16];
    let s2 = [1u8; 16];
    let k1 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &s1, &params).unwrap();
    let k2 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &s2, &params).unwrap();
    assert_ne!(k1.as_ref(), k2.as_ref());
}

#[test]
fn derive_key_differs_with_wrong_passphrase() {
    let params = KdfParams::default();
    let salt = [0u8; 16];
    let k1 = derive_key(&Zeroizing::new(b"hunter2".to_vec()), &salt, &params).unwrap();
    let k2 = derive_key(&Zeroizing::new(b"HUNTER2".to_vec()), &salt, &params).unwrap();
    assert_ne!(k1.as_ref(), k2.as_ref());
}

#[test]
fn derive_key_rejects_short_salt() {
    let params = KdfParams::default();
    let salt = [0u8; 4];
    let err = derive_key(&Zeroizing::new(b"x".to_vec()), &salt, &params).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("salt"));
}

#[test]
fn kdf_params_json_roundtrip() {
    let p = KdfParams { m_cost: 65536, t_cost: 3, p_cost: 1 };
    let s = serde_json::to_string(&p).unwrap();
    let p2: KdfParams = serde_json::from_str(&s).unwrap();
    assert_eq!(p, p2);
}
