# uno-net

Uno Work's tunnel engine for **Network**: WireGuard and AmneziaWG entirely in
user space (amneziawg-go + gVisor netstack). No root, no TUN device, no
routes. The way in is a SOCKS5 server on loopback (TCP CONNECT and UDP
ASSOCIATE) that opens only with a token. The way out is encrypted UDP to the
exit, nothing else.

Who uses it:

- the Work daemon (`apps/server`) starts it, gives it the config over the
  control API and reads its state for `/api/manager/network`;
- the macOS network extension hands it the flows of Uno Work, everything Uno
  Work starts and Docker Desktop through the SOCKS port.

## Rules it keeps

- **Fail closed.** While the tunnel is not up every SOCKS request is refused
  (`network unreachable`) and UDP is dropped. There is no direct path in the
  code at all: every dial goes through the tunnel's netstack.
- **Names resolve inside the tunnel** (its DNS), never on the machine. The
  only lookup outside is the exit's own endpoint name.
- **Never reached through an exit:** loopback, unspecified, link-local
  (169.254.169.254 is cloud metadata on the exit's machine), multicast — by
  address or by a name that resolves to one.
- **Loopback only, tokens from the environment.** `UNO_NET_SOCKS_TOKEN` and
  `UNO_NET_CONTROL_TOKEN` (32+ chars, different); never on the command line.
  The control API also checks `Host` (no DNS rebinding from a web page).
- **Auto:** transports are tried in order (WireGuard, then AmneziaWG) with a
  handshake timeout each; after a drop it starts again with the one that
  worked. AmneziaWG with no obfuscation is WireGuard on the wire.

## Run

```sh
UNO_NET_SOCKS_TOKEN=… UNO_NET_CONTROL_TOKEN=… uno-net run --lifeline
# stdout: {"ready":true,"socks":"127.0.0.1:52011","control":"127.0.0.1:52012","version":"…"}
```

`--lifeline`: exit when stdin closes, so the engine never outlives the daemon
that started it (macOS has no parent-death signal).

Control API (`Authorization: Bearer <control token>`):

| Request             | What                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/status`    | state: `status` off / connecting / on / down, `activeProtocol`, `transport` (index), `endpoint`, `since`, `lastHandshake`, `rxBytes`, `txBytes`, `latencyMs`, `error`, `socks`, `flows` |
| `GET /v1/health`    | the same; 200 when on, 503 otherwise                                                                                                                                                    |
| `GET /v1/events`    | server-sent events, `event: status` at every change                                                                                                                                     |
| `PUT /v1/config`    | replace the config; the tunnel restarts with it                                                                                                                                         |
| `DELETE /v1/config` | stop: off, nothing goes out                                                                                                                                                             |

Config (keys base64, as WireGuard writes them):

```json
{
  "transports": [
    {
      "protocol": "wireguard",
      "privateKey": "…",
      "addresses": ["10.66.0.2/32"],
      "dns": ["10.66.0.1"],
      "peer": { "publicKey": "…", "endpoint": "gw.example.net:51820" }
    },
    {
      "protocol": "amneziawg",
      "privateKey": "…",
      "addresses": ["10.66.0.2/32"],
      "dns": ["10.66.0.1"],
      "obfuscation": {
        "jc": "4",
        "jmin": "40",
        "jmax": "70",
        "s1": "15",
        "s2": "18",
        "h1": "1234567",
        "h2": "2345678",
        "h3": "3456789",
        "h4": "4567890"
      },
      "peer": { "publicKey": "…", "endpoint": "gw.example.net:51821" }
    },
    { "conf": "[Interface]\nPrivateKey = …\n…" }
  ],
  "handshakeTimeoutMs": 12000,
  "probe": "10.66.0.1",
  "probeIntervalMs": 5000,
  "probeFailures": 3
}
```

`conf` is an imported wg-quick / AmneziaWG config. Health: a handshake older
than 190 s, or `probeFailures` probes in a row (an ICMP echo to `probe` and a
DNS lookup through the tunnel, at once; either answering counts) mean down.
A missed probe is retried within a second, and a dial that fails through the
tunnel asks for a probe at once. Measured on a real gateway: down about 12 s
after the exit dies, back on about 5 s after it returns.

Other commands: `uno-net keygen` (a device key pair), `uno-net parse-conf`
(wg-quick text on stdin → transport JSON), `uno-net version`.

## Build and test

```sh
./build.sh              # dist/darwin-arm64, dist/darwin-amd64 (+ universal on macOS)
go test ./...           # Linux is enough: the exit runs inside the test process
```

`internal/e2e` brings up a real WireGuard / AmneziaWG exit in the test
process and checks TCP and UDP (by address and by name), DNS through UDP,
Auto falling back to AmneziaWG, fail-closed when the exit dies and recovery
when it returns, blocked destinations and the token.

## uno-gw: the exit side

`cmd/uno-gw` (Linux, root) is the gateway: one TUN interface per protocol
(amneziawg-go), a peer per device, NAT out, and an nft table `inet uno_gw`
that lets peers reach the internet and nothing else:

- no peer-to-peer traffic (devices of different accounts never see each other);
- nothing to the gateway's own services (only ping);
- no private, CGNAT, link-local / metadata, multicast or reserved ranges;
- TCP MSS clamped to the path MTU.

Where Docker set the iptables FORWARD policy to DROP, uno-gw lets only its
own interfaces through (DOCKER-USER), and removes that on exit.

```sh
uno-gw run --config /etc/uno-gw/config.json   # SIGHUP reloads peers
uno-gw ruleset --config …                      # print the nft script
```

```json
{
  "egress": "eth0",
  "interfaces": [
    {
      "name": "unowg0",
      "protocol": "wireguard",
      "listenPort": 51820,
      "privateKey": "…",
      "address": "10.66.0.1/24"
    },
    {
      "name": "unoawg0",
      "protocol": "amneziawg",
      "listenPort": 51821,
      "privateKey": "…",
      "address": "10.67.0.1/24",
      "obfuscation": {
        "jc": "4",
        "jmin": "40",
        "jmax": "70",
        "s1": "15",
        "s2": "18",
        "h1": "1234567",
        "h2": "2345678",
        "h3": "3456789",
        "h4": "4567890"
      }
    }
  ],
  "peers": [
    {
      "interface": "unowg0",
      "publicKey": "…",
      "address": "10.66.0.2",
      "label": "account 85 · Mac"
    },
    { "interface": "unoawg0", "publicKey": "…", "address": "10.67.0.2" }
  ]
}
```

Checked 13.11 on a Uno cloud computer (box 6777, test only): WireGuard
up, 4 ms, HTTPS fine, 10 MB at ~50 MB/s; the node's network, the gateway's
own SSH and metadata unreachable; with WireGuard's port blocked Auto moved
to AmneziaWG; exit stopped → down ~12 s, back ~5 s after restart.
