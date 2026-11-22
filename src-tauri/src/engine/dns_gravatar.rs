use md5::{Digest, Md5};
use reqwest::Client;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::UdpSocket;

#[derive(Debug, Clone, Default)]
pub struct DomainDnsReport {
    pub domain: String,
    pub mx_records: Vec<String>,
    pub spf_record: Option<String>,
    pub dmarc_record: Option<String>,
    pub mail_provider_hint: Option<String>,
}

/// Direct raw Gravatar image existence check (`HEAD https://www.gravatar.com/avatar/{md5}?d=404`).
/// Zero API calls — checks raw avatar endpoint HTTP 200 vs 404 directly from the laptop.
pub async fn check_gravatar_raw_hash(client: &Client, email: &str) -> Option<(String, String)> {
    let normalized = email.trim().to_lowercase();
    if !normalized.contains('@') {
        return None;
    }
    let mut hasher = Md5::new();
    hasher.update(normalized.as_bytes());
    let md5_hex = hex::encode(hasher.finalize());
    let url = format!("https://www.gravatar.com/avatar/{}?d=404", md5_hex);

    let resp = client
        .head(&url)
        .timeout(Duration::from_secs(6))
        .send()
        .await
        .ok()?;

    if resp.status().is_success() {
        Some((
            md5_hex,
            format!("https://www.gravatar.com/avatar/{}", md5_hex),
        ))
    } else {
        None
    }
}

/// Direct RFC 1035 DNS-over-UDP MX/SPF/DMARC inspection — zero HTTP/third-party DNS APIs.
pub async fn inspect_domain_dns(domain: &str) -> DomainDnsReport {
    let clean = domain.trim().trim_end_matches('.').to_lowercase();
    let mut report = DomainDnsReport {
        domain: clean.clone(),
        ..Default::default()
    };

    if !clean.contains('.') {
        return report;
    }

    // Type 15 = MX, Type 16 = TXT
    let mx = dns_udp_query(&clean, 15).await.unwrap_or_default();
    let txt = dns_udp_query(&clean, 16).await.unwrap_or_default();
    let dmarc_txt = dns_udp_query(&format!("_dmarc.{}", clean), 16)
        .await
        .unwrap_or_default();

    report.mx_records = mx;
    report.spf_record = txt
        .into_iter()
        .find(|t| t.to_lowercase().contains("v=spf1"));
    report.dmarc_record = dmarc_txt
        .into_iter()
        .find(|t| t.to_lowercase().contains("v=dmarc1"));

    let mx_joined = report.mx_records.join(" ").to_lowercase();
    report.mail_provider_hint = if mx_joined.contains("google") || mx_joined.contains("aspmx") {
        Some("Google Workspace".to_string())
    } else if mx_joined.contains("outlook") || mx_joined.contains("protection.outlook") {
        Some("Microsoft 365".to_string())
    } else if mx_joined.contains("protonmail") || mx_joined.contains("proton.ch") {
        Some("Proton Mail".to_string())
    } else if mx_joined.contains("mimecast") {
        Some("Mimecast Gateway".to_string())
    } else if mx_joined.contains("pphosted") || mx_joined.contains("proofpoint") {
        Some("Proofpoint Gateway".to_string())
    } else if mx_joined.contains("fastmail") {
        Some("Fastmail".to_string())
    } else {
        None
    };

    report
}

/// Minimal pure-Rust RFC 1035 DNS-over-UDP query supporting MX (15) and TXT (16) records.
async fn dns_udp_query(name: &str, qtype: u16) -> Result<Vec<String>, String> {
    let packet = build_dns_query(name, qtype);
    let resolvers: [SocketAddr; 2] = ["1.1.1.1:53".parse().unwrap(), "8.8.8.8:53".parse().unwrap()];

    for resolver in resolvers {
        let socket = match UdpSocket::bind("0.0.0.0:0").await {
            Ok(s) => s,
            Err(_) => continue,
        };
        if socket.send_to(&packet, resolver).await.is_err() {
            continue;
        }
        let mut buf = [0u8; 2048];
        let recv = tokio::time::timeout(Duration::from_secs(3), socket.recv_from(&mut buf)).await;
        if let Ok(Ok((len, _))) = recv {
            if len >= 12 {
                return Ok(parse_dns_response(&buf[..len], qtype));
            }
        }
    }

    Ok(Vec::new())
}

pub fn build_dns_query(name: &str, qtype: u16) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(64);
    // Transaction ID, Flags (RD=1), QDCOUNT=1, ANCOUNT=0, NSCOUNT=0, ARCOUNT=0
    pkt.extend_from_slice(&[
        0x42, 0x77, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    for label in name.split('.') {
        if label.is_empty() || label.len() > 63 {
            continue;
        }
        pkt.push(label.len() as u8);
        pkt.extend_from_slice(label.as_bytes());
    }
    pkt.push(0); // root terminator
    pkt.extend_from_slice(&qtype.to_be_bytes());
    pkt.extend_from_slice(&1u16.to_be_bytes()); // IN class
    pkt
}

fn read_dns_name(buf: &[u8], mut offset: usize) -> Option<(String, usize)> {
    let mut labels = Vec::new();
    let mut jumped = false;
    let mut end_offset = offset;
    let mut hops = 0;

    while offset < buf.len() && hops < 24 {
        hops += 1;
        let len = buf[offset];
        if len == 0 {
            if !jumped {
                end_offset = offset + 1;
            }
            break;
        }
        if (len & 0xC0) == 0xC0 {
            if offset + 1 >= buf.len() {
                return None;
            }
            let ptr = (((len & 0x3F) as usize) << 8) | (buf[offset + 1] as usize);
            if !jumped {
                end_offset = offset + 2;
                jumped = true;
            }
            offset = ptr;
            continue;
        }
        let l = len as usize;
        offset += 1;
        if offset + l > buf.len() {
            return None;
        }
        if let Ok(s) = std::str::from_utf8(&buf[offset..offset + l]) {
            labels.push(s.to_string());
        }
        offset += l;
        if !jumped {
            end_offset = offset;
        }
    }

    Some((labels.join("."), end_offset))
}

fn parse_dns_response(buf: &[u8], expected_qtype: u16) -> Vec<String> {
    if buf.len() < 12 {
        return Vec::new();
    }
    let qdcount = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let ancount = u16::from_be_bytes([buf[6], buf[7]]) as usize;

    let mut pos = 12;
    for _ in 0..qdcount {
        let Some((_, next)) = read_dns_name(buf, pos) else {
            return Vec::new();
        };
        pos = next + 4; // QTYPE + QCLASS
        if pos > buf.len() {
            return Vec::new();
        }
    }

    let mut out = Vec::new();
    for _ in 0..ancount {
        let Some((_, next)) = read_dns_name(buf, pos) else {
            break;
        };
        pos = next;
        if pos + 10 > buf.len() {
            break;
        }
        let rtype = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let rdlength = u16::from_be_bytes([buf[pos + 8], buf[pos + 9]]) as usize;
        pos += 10;
        if pos + rdlength > buf.len() {
            break;
        }
        let rdata_start = pos;
        let rdata_end = pos + rdlength;

        if rtype == expected_qtype {
            if rtype == 15 && rdlength >= 3 {
                // MX: 2-byte preference + domain name
                let pref = u16::from_be_bytes([buf[rdata_start], buf[rdata_start + 1]]);
                if let Some((exchange, _)) = read_dns_name(buf, rdata_start + 2) {
                    if !exchange.is_empty() {
                        out.push(format!("{} {}", pref, exchange));
                    }
                }
            } else if rtype == 16 {
                // TXT: sequence of length-prefixed character strings
                let mut tpos = rdata_start;
                let mut txt_val = String::new();
                while tpos < rdata_end {
                    let slen = buf[tpos] as usize;
                    tpos += 1;
                    if tpos + slen > rdata_end {
                        break;
                    }
                    if let Ok(chunk) = std::str::from_utf8(&buf[tpos..tpos + slen]) {
                        txt_val.push_str(chunk);
                    }
                    tpos += slen;
                }
                if !txt_val.is_empty() {
                    out.push(txt_val);
                }
            }
        }
        pos = rdata_end;
    }

    out
}
