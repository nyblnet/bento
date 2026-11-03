// Verdicts for files named on the command line, against the corpus history.
use bento_gate1::*;
fn main() {
    let d = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/gate1/");
    let key: serde_json::Value = serde_json::from_slice(&std::fs::read(format!("{d}test-public-key.json")).unwrap()).unwrap();
    let h = History::from_signed(&std::fs::read_to_string(format!("{d}history.json")).unwrap(), key["x"].as_str().unwrap(), key["y"].as_str().unwrap()).unwrap();
    for f in std::env::args().skip(1) {
        match verify_served(&std::fs::read(&f).unwrap(), &h, "'none'") {
            ServedVerdict::Genuine { release, .. } => println!("RUST {} genuine {}", f.rsplit('/').next().unwrap(), release.version),
            ServedVerdict::Unknown { reason } => println!("RUST {} unknown {reason}", f.rsplit('/').next().unwrap()),
        }
    }
}
