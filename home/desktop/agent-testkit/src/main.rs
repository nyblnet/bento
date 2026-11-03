// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// TEST-ONLY. A virtual FIDO2 security key for the desktop agent's rigs:
// Google's OpenSK CTAP2 implementation (Apache-2.0, pinned commit) behind a
// Linux uhid device, so libfido2 (the agent) and an independent WebAuthn client
// can talk to the SAME authenticator over /dev/hidrawN.
//
// This is our own uhid adapter (MIT). It is never linked into the shipped
// agent; CI asserts the shipped dependency graph does not contain it.

use opensk::ctap::hid::HidPacket;
use opensk::env::test::TestEnv;
use opensk::{Ctap, Transport};
use std::fs::OpenOptions;
use std::io::{Read, Write};

const UHID_DESTROY: u32 = 1;
const UHID_OUTPUT: u32 = 6;
const UHID_CREATE2: u32 = 11;
const UHID_INPUT2: u32 = 12;
const EVENT_SIZE: usize = 4380;

/// CTAP-HID report descriptor: FIDO usage page 0xF1D0, 64-byte reports.
const REPORT_DESCRIPTOR: [u8; 34] = [
    0x06, 0xD0, 0xF1, 0x09, 0x01, 0xA1, 0x01, 0x09, 0x20, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x40,
    0x81, 0x02, 0x09, 0x21, 0x15, 0x00, 0x26, 0xFF, 0x00, 0x75, 0x08, 0x95, 0x40, 0x91, 0x02, 0xC0,
];

fn create_event() -> Vec<u8> {
    let mut ev = Vec::with_capacity(EVENT_SIZE);
    ev.extend_from_slice(&UHID_CREATE2.to_le_bytes());
    let mut name = b"bento-agent-testkit (OpenSK)".to_vec();
    name.resize(128, 0);
    ev.extend_from_slice(&name);
    ev.extend_from_slice(&[0u8; 64]); // phys
    ev.extend_from_slice(&[0u8; 64]); // uniq
    ev.extend_from_slice(&(REPORT_DESCRIPTOR.len() as u16).to_le_bytes());
    ev.extend_from_slice(&0x03u16.to_le_bytes()); // BUS_USB
    ev.extend_from_slice(&0x1209u32.to_le_bytes()); // pid.codes test VID
    ev.extend_from_slice(&0xbe71u32.to_le_bytes());
    ev.extend_from_slice(&0u32.to_le_bytes()); // version
    ev.extend_from_slice(&0u32.to_le_bytes()); // country
    ev.extend_from_slice(&REPORT_DESCRIPTOR);
    ev.resize(EVENT_SIZE, 0);
    ev
}

fn input_event(packet: &HidPacket) -> Vec<u8> {
    let mut ev = Vec::with_capacity(EVENT_SIZE);
    ev.extend_from_slice(&UHID_INPUT2.to_le_bytes());
    ev.extend_from_slice(&(packet.len() as u16).to_le_bytes());
    ev.extend_from_slice(packet);
    ev.resize(EVENT_SIZE, 0);
    ev
}

fn main() {
    let mut uhid = OpenOptions::new().read(true).write(true).open("/dev/uhid").expect("open /dev/uhid (privileged, uhid module)");
    uhid.write_all(&create_event()).expect("UHID_CREATE2");
    let mut ctap = Ctap::new(TestEnv::default());
    eprintln!("bento-agent-testkit: virtual OpenSK authenticator up");
    let mut buf = vec![0u8; EVENT_SIZE];
    loop {
        let n = match uhid.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("uhid read: {e}");
                break;
            }
        };
        if n < 4 {
            continue;
        }
        let ty = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        if ty != UHID_OUTPUT {
            continue;
        }
        // struct uhid_output_req { __u8 data[4096]; __u16 size; __u8 rtype; }
        let size = u16::from_le_bytes(buf[4 + 4096..4 + 4098].try_into().unwrap()) as usize;
        let data = &buf[4..4 + size.min(4096)];
        // hidraw writes carry a leading report number (0) for devices without
        // report IDs; strip it so OpenSK sees the 64-byte CTAP-HID packet.
        let report = if data.len() == 65 { &data[1..] } else { data };
        if report.len() != 64 {
            continue;
        }
        let packet: HidPacket = report.try_into().unwrap();
        for reply in ctap.process_hid_packet(&packet, Transport::MainHid) {
            uhid.write_all(&input_event(&reply)).expect("UHID_INPUT2");
        }
    }
    let mut destroy = UHID_DESTROY.to_le_bytes().to_vec();
    destroy.resize(EVENT_SIZE, 0);
    let _ = uhid.write_all(&destroy);
}
