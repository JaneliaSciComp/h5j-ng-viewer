# Deploying `h5j-ng-viewer` on an internal Ubuntu 24.04 server

This guide walks through serving the app from a single Ubuntu 24.04 machine so other
people on your internal network can reach it in a browser. The app is built into static
files on your development machine (or on the server itself), and a Docker container
running nginx serves those files over HTTPS with the `Cross-Origin-Embedder-Policy` and
`Cross-Origin-Opener-Policy` headers that `ffmpeg.wasm` — and therefore this app's H.265
decoding — requires.

Certificates, self-signed for testing and then real ones from your networking group, are
mounted from a fixed path on the host, so you swap them without rebuilding anything.

The steps assume you have `sudo` on the Ubuntu server. Anywhere you see `<something>` in
angle brackets, substitute the actual value.

## Why this app needs a real web server

It is a static site, but it needs two things a plain file host cannot give it, which is
why GitHub Pages and similar are not an option:

- **Two response headers on every response.** `Cross-Origin-Opener-Policy: same-origin`
  and `Cross-Origin-Embedder-Policy: require-corp`. Without both, the browser does not
  define `SharedArrayBuffer`; without that, `ffmpeg.wasm` cannot start the threads its
  H.265 decoder needs. `src/main.tsx` checks for this and refuses to start with an
  explanatory message, so the symptom is a clear error rather than a blank page.
- **HTTPS, or `localhost`.** Service workers, OPFS and `SharedArrayBuffer` are all hidden
  outside a secure context, and browsers signal that by simply not defining the API. A
  bare `http://<ip>` therefore fails looking like "this browser has no service workers".

**The app must be served from the origin root.** Not a sub-path. Neuroglancer's chunk
worker is constructed from the absolute, build-time-baked path
`/assets/chunk_worker.bundle-<hash>.js`, so `https://host/viewer/` would 404 on the one
file that fetches every voxel. `vite.config.ts` pins `base: "/"` for this reason.

Nothing is uploaded anywhere and no server-side conversion happens: the browser fetches
the H5J, decodes it, and writes the converted volume into its own private storage. The
server only ever serves static files.

---

## 1. What lives where

By the end of setup, the Ubuntu server will have this layout:

```
~/h5j-ng-viewer/                        # your working directory (any name; ~ is fine)
├── dist/                               # the output of `npm run build`
│   ├── index.html
│   ├── sw.js                           # the service worker; must sit at the root
│   ├── assets/                         # hashed app + Neuroglancer chunks
│   └── ffmpeg-core/                    # the vendored ffmpeg.wasm core (~23 MB)
└── deploy/
    ├── nginx.conf                      # copied from the repo
    └── docker-compose.yml              # copied from the repo

/etc/h5j-ng-viewer/certs/               # certs, owned by root
├── h5j-ng-viewer.crt
└── h5j-ng-viewer.key
```

The container `h5j-ng-viewer` (a stock `nginx:alpine`) mounts `dist/` read-only as its
web root, mounts `nginx.conf` as its config, and mounts `/etc/h5j-ng-viewer/certs/` for
TLS.

There is **no Dockerfile** and **no image build** — everything the container needs is
either in the public `nginx:alpine` image or bind-mounted from the host.

Two details of that layout are load-bearing rather than incidental:

- **`sw.js` must be at the root**, because it is registered with scope `/` and a service
  worker cannot claim a scope above its own path. Vite puts it there automatically
  (it lives in `public/`); just do not reorganize it into `assets/`.
- **`ffmpeg-core/` must be served by you**, not fetched from a CDN. `ffmpeg.wasm` 0.10
  defaults its `corePath` to unpkg.com, and cross-origin isolation blocks that; the build
  vendors the three files locally and `src/lib/h5j.ts` passes an explicit
  `/ffmpeg-core/ffmpeg-core.js`. A useful side effect is that a fully air-gapped network
  works with no changes.

---

## 2. One-time setup on the Ubuntu server

### 2a. Install Docker

Ubuntu's `docker.io` package works, but the version can lag. Install from Docker's
official repository so you get modern `docker compose`:

```bash
# Add Docker's official GPG key and repo.
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install engine + compose plugin.
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Let your user run docker without sudo (log out and back in for this to take effect).
sudo usermod -aG docker $USER
```

Verify:

```bash
docker --version
docker compose version
```

### 2b. Open the firewall

If UFW is enabled:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

If you are running this alongside another container that already owns 443, open the port
you are giving this one instead — see
[Section 6a](#6a-running-alongside-another-container-on-the-same-host):

```bash
sudo ufw allow 8443/tcp
```

If UFW is not enabled you can skip this; the ports are already open.

### 2c. Create the working directory

```bash
mkdir -p ~/h5j-ng-viewer
```

---

## 3. Build the app

### 3a. Node version — check this first

The build needs **Node 20.19+ or 22.12+**. Vite 7 calls `crypto.hash()`, which older
Node does not have, and the failure names neither Node nor the version:

```
error during build:
[vite:worker-import-meta-url] crypto.hash is not a function
```

Node 21.6 in particular is new enough to look fine and old enough to fail. Check before
you start:

```bash
node --version
```

If it is too old and you use `nvm`:

```bash
nvm use 22
```

### 3b. Build

Run this on **whichever machine has the source code** — your Mac, your laptop, or the
Ubuntu server itself.

```bash
cd path/to/h5j-ng-viewer
npm install                             # if you haven't already
npm run build
```

Note that the repo currently carries only `pnpm-lock.yaml`, so `npm install` resolves its
own dependency tree rather than an already-tested one. If you want the deployed build to
come from pinned versions, commit a `package-lock.json` (run `npm install` once and keep
the file it writes).

This produces a **`dist/`** directory next to `package.json`, about 36 MB. That is
everything the browser needs. Roughly 5 MB of it is source maps, which you can delete if
you would rather not publish them — the app runs without them, you just get minified
stack traces.

Worth a glance before you ship it: the build prints a warning that the main chunk is over
500 kB. That is expected — Neuroglancer is most of it — and not a problem to solve here.

### 3c. Copy `dist/` to the server (only if you built on a different machine)

```bash
# From your dev machine.  Adjust user@host to your server's SSH login.
rsync -av --delete dist/ user@<server-host>:~/h5j-ng-viewer/dist/
```

The trailing slash on `dist/` matters — it copies the *contents*, so on the server
`~/h5j-ng-viewer/dist/index.html` exists.

If you built on the Ubuntu server itself, copy the directory into place instead:

```bash
cp -r path/to/h5j-ng-viewer/dist ~/h5j-ng-viewer/
```

### 3d. Copy the deploy files

Both live in the repo, so there is nothing to type by hand:

```bash
# From your dev machine.
rsync -av deploy/ user@<server-host>:~/h5j-ng-viewer/deploy/
```

Or, if you built on the server, they are already there as part of the checkout.

---

## 4. Generate a self-signed certificate for testing

The container reads two files at fixed paths:

- `/etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt`
- `/etc/h5j-ng-viewer/certs/h5j-ng-viewer.key`

For testing you generate a self-signed pair; later, real certs go at the same paths. Run
these commands **on the Ubuntu server**:

```bash
sudo mkdir -p /etc/h5j-ng-viewer/certs

# Figure out the names we want the cert to be valid for.
FQDN=$(hostname -f)                              # e.g. myhost.internal.example.org
SHORT=$(hostname)                                # e.g. myhost
LAN_IP=$(hostname -I | awk '{print $1}')         # e.g. 10.36.7.42

echo "Cert will be valid for: $FQDN, $SHORT, localhost, $LAN_IP, 127.0.0.1"

sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout /etc/h5j-ng-viewer/certs/h5j-ng-viewer.key \
  -out    /etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt \
  -subj "/CN=$FQDN" \
  -addext "subjectAltName=DNS:$FQDN,DNS:$SHORT,DNS:localhost,IP:$LAN_IP,IP:127.0.0.1"

# The certificate is public (the server hands it to every browser that connects) so it
# can be world-readable.  The private key is a secret and must not be, hence the two
# different modes.
sudo chmod 644 /etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt
sudo chmod 640 /etc/h5j-ng-viewer/certs/h5j-ng-viewer.key
```

To sanity-check what URLs the cert will accept:

```bash
openssl x509 -in /etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt -noout -text | \
  grep -A1 "Subject Alternative Name"
```

You should see something like:

```
X509v3 Subject Alternative Name:
    DNS:myhost.internal.example.org, DNS:myhost, DNS:localhost, IP Address:10.36.7.42, IP Address:127.0.0.1
```

Those are exactly the values `<the-host>` in `https://<the-host>` can be without the
browser giving up. See [Section 7](#7-what-url-to-type-in-the-browser).

---

## 5. The two config files

Both are in `deploy/` in the repo, copied across in step 3d. You do not need to write
them, but two things in `nginx.conf` are worth knowing about before you edit it.

**The cross-origin headers are repeated in every location block, on purpose.** nginx's
`add_header` does not inherit into a location that sets any `add_header` of its own, so a
location that adds a `Cache-Control` silently loses the two isolation headers. That
failure is unpleasant precisely because it is partial: the app works on a first visit and
stops working after a cache hit. If you add a location block, copy those two lines into
it.

**`location /zarr/` returns 404 deliberately.** That path is not real — the service
worker invents it and answers those requests out of the browser's own storage, so nothing
should ever reach nginx there. Letting the SPA fallback serve `index.html` instead would
hand Neuroglancer HTML with a `200` where it expected voxels, and the parse error it
reports says nothing about the actual problem, which is that the service worker is not
registered.

The cache policy is worth a sentence too, since it differs per directory:

| Path | Policy | Why |
|---|---|---|
| `index.html` | `no-cache` | 408 bytes; a rebuild must be picked up without users clearing anything |
| `sw.js` | `no-cache` | An old worker with a new build disagrees about the on-disk layout |
| `assets/` | one year, `immutable` | Hashed filenames — the name changes when the content does |
| `ffmpeg-core/` | `no-cache` | 23 MB, so worth keeping, but *not* hashed: an upgrade reuses the filenames, and a 304 costs nothing |

---

## 6. Start the container

From the `deploy/` directory:

```bash
cd ~/h5j-ng-viewer/deploy
docker compose up -d
```

- `up` creates and starts the container.
- `-d` runs it in the background ("detached" mode).

Check it's running:

```bash
docker compose ps
```

You should see `h5j-ng-viewer` with state `running`.

Check the nginx logs (useful if anything goes wrong):

```bash
docker compose logs -f
```

Press Ctrl-C to stop following the logs. The container keeps running.

Because of `restart: unless-stopped`, the container comes back automatically after a
server reboot.

### 6a. Running alongside another container on the same host

Two containers cannot both bind port 443, so give this one a different **host** port.
Only the host side of the mapping moves; nginx still listens on 443 inside the
container, so `nginx.conf` needs no change.

Create a `.env` file beside `docker-compose.yml`:

```bash
cd ~/h5j-ng-viewer/deploy
echo "HTTPS_PORT=8443" > .env
docker compose up -d
```

Then browse `https://<the-host>:8443`. Compose reads `.env` automatically, so the port
survives a `down`/`up` without anyone having to remember it.

Three things to get right, two of which fail in ways that affect the *other* app:

- **Leave port 80 unmapped.** It is commented out in `docker-compose.yml` for this
  reason. That listener does nothing but redirect to HTTPS, and the redirect is built
  from nginx's `$host`, which carries no port — so a visitor to `http://<host>` would be
  sent to `https://<host>/`, which is your other app. Unmapped, the redirect block is
  dead but harmless, and people simply type `https://` themselves.
- **The Compose project name must differ.** `docker-compose.yml` sets
  `name: h5j-ng-viewer` for this. Without it, Compose names the project after the
  directory the file lives in — `deploy` — which is very likely what the other app's
  directory is called too. Two projects sharing a name is not a warning: `docker compose
  down` in one directory removes every container labelled with that project, the other
  app's included.
- **The container name must differ**, which `container_name: h5j-ng-viewer` already
  handles as long as the other app is not also called that.

Certificates need no special handling: a cert's validity is a list of hostnames and IPs,
and ports are not part of it. Generate this instance its own pair as in Section 4, or
copy the other app's into `/etc/h5j-ng-viewer/certs/` under the filenames this compose
file expects.

**Note that the port is part of the origin.** `https://host:8443` and `https://host` are
different origins as far as the browser is concerned, so this instance gets its own
service worker registration and its own private storage, entirely separate from whatever
else is on the host. That is the behaviour you want — but it also means changing the port
later gives every user an empty cache at the new address and orphans the converted
volumes they had at the old one.

---

## 7. What URL to type in the browser

The cert has a fixed list of names and IPs it is valid for (the `subjectAltName` list
from Section 4). Browsers reject anything else outright, regardless of what nginx would
serve.

If you set `HTTPS_PORT` (Section 6a), append `:<that port>` to every URL below —
`https://localhost:8443` rather than `https://localhost`.

**From the Ubuntu server itself**, any of these work:

- `https://localhost`
- `https://127.0.0.1`
- `https://<the-server's-short-hostname>` (whatever `hostname` printed)
- `https://<the-server's-FQDN>` (whatever `hostname -f` printed)

**From another machine on the internal network**, one of these will work depending on
your network:

- `https://<FQDN>` — works if your internal DNS resolves `<FQDN>` to the server's IP.
  This is the nicest option; ask your networking group, as often it is already set up.
- `https://<the-server's-IP-address>` — always works if the client can reach that IP.

If unsure, `ping <FQDN>` from the client machine. If it resolves and replies, use the
FQDN; if not, use the IP.

**Use `https://`, never `http://`.** The app genuinely cannot run over plain http to
anything but localhost. On the default port the redirect in `nginx.conf` catches a typo;
on a custom port, port 80 is deliberately unmapped, so there is nothing to catch it.

### Clicking through the certificate warning is NOT enough for this app

For most sites, a self-signed cert means one "Advanced → Proceed (unsafe)" per browser
and you are done. **Not here**, for two reasons that stack:

- **The interstitial is a navigation affordance.** Chrome offers "Proceed (unsafe)" when a
  top-level page load hits a certificate error, because there is a document to replace
  with the warning and a user to ask. The service worker script is fetched out of band by
  the browser's service-worker machinery, not as a navigation, so there is nothing to
  interrupt and no way to prompt — the fetch simply fails.
- **The exception would not help anyway.** Chrome refuses to register a service worker
  over a connection with certificate errors even when the user has already clicked
  through for that origin. The granted exception deliberately does not extend to it.

So the page loads, the app starts, and then registration fails with no UI attached:

```
Cannot start
Failed to register a ServiceWorker for scope ('https://10.101.10.26:8443/') with
script ('https://10.101.10.26:8443/sw.js'): An SSL certificate error occurred when
fetching the script.
```

The service worker is not optional — it is what serves the converted volume to
Neuroglancer — so the certificate has to be genuinely *trusted* on each client machine,
not bypassed. Three ways, in the order they are usually worth trying:

**a. Trust the self-signed cert on the client** — one-time per machine, works for a small
group, no waiting on anyone. Copy the `.crt` (not the `.key`) off the server:

```bash
scp user@<server-host>:/etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt .
```

Then install it as a trusted root:

- **macOS** (covers Chrome, Edge and Safari, which use the system store):
  ```bash
  sudo security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain h5j-ng-viewer.crt
  ```
  Or double-click it, find it in Keychain Access under "System", and set *Trust → When
  using this certificate* to *Always Trust*.
- **Windows**: double-click → *Install Certificate* → *Local Machine* → *Place all
  certificates in the following store* → **Trusted Root Certification Authorities**.
- **Linux, Chrome**:
  ```bash
  certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n h5j-ng-viewer -i h5j-ng-viewer.crt
  ```
- **Firefox** keeps its own store on every platform: *Settings → Privacy & Security →
  Certificates → View Certificates → Authorities → Import*, and check "Trust this CA to
  identify websites".

Restart the browser afterwards, then confirm the padlock shows no warning before
expecting the app to load.

**b. Get a real certificate** from your networking group and install it as in
[Section 10](#10-swapping-in-a-real-certificate-later). This is the only option that
scales past a handful of machines, since it needs nothing done on the clients at all.

**c. SSH-tunnel to a plain-HTTP listener** — for one person testing right now; useless as
a way to share. `http://localhost` is a secure context *by definition*, whatever port it
is on, so tunnelling to an HTTP endpoint sidesteps certificates entirely:

```bash
ssh -L 3000:localhost:8080 user@<server-host>
# then browse http://localhost:3000
```

This needs nginx to serve the site over plain HTTP on a port that is **not** published to
the network — the `server` block in `nginx.conf` listening on 80 only redirects to HTTPS,
so it will not do. Add a second block that serves content over HTTP with the same two
isolation headers, map it in `docker-compose.yml` bound to `127.0.0.1` only, and reach it
through the tunnel.

Note that tunnelling to the **HTTPS** port instead does not help: `https://localhost:8443`
is still a connection with a certificate error, and the service-worker rule above is about
the connection, not about which origin is asking.

### Opening a file

The app takes the file to view from the address bar, so the URL people actually share
looks like this:

```
https://<the-host>/?h5j=<the URL of an H5J file, percent-encoded>&chs=0,1
```

`chs` picks which channels start visible; every channel is converted regardless. Users
can also drag a local `.h5j` onto the viewer, though a dropped file has no URL and so
that session is not shareable.

**The H5J's own host must send CORS headers.** The browser fetches it directly, so a
bucket without `Access-Control-Allow-Origin` cannot be read from the page at all and no
amount of configuration here helps. To check one:

```bash
curl -sI -H 'Origin: https://<the-host>' "<the H5J URL>" | grep -i access-control
```

The Janelia FlyLight imagery bucket does cooperate, returning
`Access-Control-Allow-Origin: *`.

---

## 8. Verify cross-origin isolation

This is the single most important check.

1. Open the app URL in Chrome.
2. Open DevTools (Cmd/Ctrl-Shift-I or F12).
3. In the Console tab, type `crossOriginIsolated` and press Enter.
4. It should print `true`.

If it prints `false`:

- You typed an `http://` URL instead of `https://`.
- The headers aren't reaching the browser. Check with:
  ```bash
  curl -kI https://<the-host>/
  ```
  You should see both `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Opener-Policy: same-origin`. `-k` accepts the self-signed cert. Also
  check a hashed asset and the worker, since those go through their own location blocks
  and are where a missing repeat of the two headers shows up:
  ```bash
  curl -kI https://<the-host>/sw.js
  ```

While you are there, two other one-line checks are worth knowing:

```js
// In the Console. Both must be true before the app can work.
crossOriginIsolated                       // → true
!!navigator.serviceWorker.controller      // → true
```

The second one being `false` means the page loaded but is not *controlled* by the service
worker, so Neuroglancer's chunk requests will not be intercepted. The app reloads itself
once to fix exactly this, so it should only ever be false mid-reload.

---

## 9. Updating the app after a code change

```bash
# On whichever machine has the source:
npm run build

# If you built on a different machine, sync to the server:
rsync -av --delete dist/ user@<server-host>:~/h5j-ng-viewer/dist/
```

That's it. Nginx serves the new files on the next request; the container does not need to
be restarted and the image does not need rebuilding.

Two things to expect on the first visit after an update:

- **One extra reload.** A new `sw.js` installs and takes control, and the app reloads once
  to become controlled by it.
- **Converted volumes from before the update may be unreadable.** They live in each
  user's browser storage in a layout the code defines, and a change to that layout leaves
  the old trees stale rather than migrating them. They waste space until cleared — the
  gear menu has "Delete all cached data" — and the file simply reconverts.

---

## 10. Swapping in a real certificate later

When your networking group hands over a real cert you'll typically get a certificate file
(sometimes just the leaf, sometimes a bundle with the intermediate chain) and a private
key. The container reads them from the same two paths, so you just replace the files:

```bash
# Back up the self-signed ones in case you want them again.
sudo cp /etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt /etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt.selfsigned
sudo cp /etc/h5j-ng-viewer/certs/h5j-ng-viewer.key /etc/h5j-ng-viewer/certs/h5j-ng-viewer.key.selfsigned

# If you got the leaf cert and the intermediate chain as separate files, concatenate
# them.  The leaf must come FIRST.
sudo bash -c 'cat leaf.crt intermediate.crt > /etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt'

# If they gave you a single bundle already, just copy it.
# sudo cp bundle.crt /etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt

# Copy the private key.
sudo cp private.key /etc/h5j-ng-viewer/certs/h5j-ng-viewer.key
sudo chmod 644 /etc/h5j-ng-viewer/certs/h5j-ng-viewer.crt
sudo chmod 640 /etc/h5j-ng-viewer/certs/h5j-ng-viewer.key

# Tell the running container to re-read them.
cd ~/h5j-ng-viewer/deploy
docker compose exec h5j-ng-viewer nginx -s reload
```

After the reload the browser warning goes away, and the URL you can type is dictated by
the real cert's subject/SAN list — usually just the FQDN it was issued for. No container
restart or rebuild is needed.

**Changing hostname is not free for existing users.** Everything the app stores —
converted volumes, the service worker registration — is keyed to the origin. Moving from
`https://10.36.7.42` to `https://myhost.example.org` gives every user an empty cache at
the new address and orphans what they had at the old one.

---

## 11. Managing the container day-to-day

All commands run from `~/h5j-ng-viewer/deploy/`.

All of them act on the project named in `docker-compose.yml`, not on whatever else is
running on the host.

- **Stop it**: `docker compose down`
- **Start it (after `down`)**: `docker compose up -d`
- **Restart it**: `docker compose restart`
- **See logs live**: `docker compose logs -f`
- **See recent logs**: `docker compose logs --tail=100`
- **Check nginx accepts a config change**: `docker compose exec h5j-ng-viewer nginx -t`
- **Reload nginx without restarting**: `docker compose exec h5j-ng-viewer nginx -s reload`
- **Upgrade the nginx base image** (occasional): `docker compose pull && docker compose up -d`

---

## 12. Troubleshooting

**Container won't start; logs show "nginx: [emerg] cannot load certificate".**
The cert or key is missing, misnamed, or unreadable:
```bash
ls -l /etc/h5j-ng-viewer/certs/
```
Both files must exist and be named exactly `h5j-ng-viewer.crt` and `h5j-ng-viewer.key`.

**"Cannot start … Failed to register a ServiceWorker … An SSL certificate error
occurred."** The self-signed certificate is not trusted on that client, and clicking
through the browser warning does not help — see
[Clicking through the certificate warning is NOT enough](#clicking-through-the-certificate-warning-is-not-enough-for-this-app).

**The page says "Cannot start" and names a missing capability.** That message is the app
telling you exactly which precondition failed, in the order they are checked: secure
context, then `navigator.serviceWorker`, then OPFS, then `SharedArrayBuffer`. The last of
those is the cross-origin-isolation problem — go to
[Section 8](#8-verify-cross-origin-isolation). The first is an `http://` URL. Note that
Firefox disables service workers entirely in Private Browsing windows.

**Everything loads but Neuroglancer's panels stay black.** Almost always the service
worker not controlling the page, so its chunk requests reach the network instead of the
browser's storage. Check `!!navigator.serviceWorker.controller` in the Console, and check
that `/zarr/...` requests are *not* appearing in the Network tab with 404s from nginx —
if they are, the worker is not intercepting them. A hard reload
(Cmd/Ctrl-Shift-R) re-registers it. Note that DevTools' "Disable cache" and "Bypass for
network" both interfere with service workers, so turn them off when testing this.

**"Cannot start" mentioning storage, or a conversion that fails partway.** These volumes
are large: an 11 MB H5J becomes about 1.3 GB uncompressed, because the browser needs it
pre-chunked and unpacked to render it. The gear menu shows how much space is used and
available, and warns before a conversion that will not fit. "Delete all cached data" is
in the same place.

**The H5J itself won't load.** Check the browser Console for a CORS error, then check the
file's host with the `curl` from [Section 7](#opening-a-file). Nothing in this deployment
can work around a bucket that does not send `Access-Control-Allow-Origin`.

**Browser can't even reach the site.** Try these in order:
1. On the server: `docker compose ps` — is the container running, and on the host port
   you expect? The `PORTS` column shows the mapping.
2. On the server: `curl -kI https://localhost/` — does nginx respond? Add the port if you
   set one: `curl -kI https://localhost:8443/`.
3. From the client: `ping <the-host>` — does the network route to the server?
4. From the client: `curl -kI https://<the-host>/` — same test as (2), over the network.

**Chrome refuses with `NET::ERR_CERT_COMMON_NAME_INVALID` and no "Advanced" button.**
The URL isn't in the cert's SAN list. Re-run the `openssl x509` check from Section 4 and
pick a URL that matches.

**A 404 on `/assets/chunk_worker.bundle-<hash>.js`.** The app is being served from a
sub-path. It has to be at the origin root; see the note at the top.

**Config changes don't seem to take effect.** After editing `nginx.conf`, either restart
the container (`docker compose restart`) or reload nginx (`docker compose exec
h5j-ng-viewer nginx -s reload`). Mounted config files are read when nginx re-reads them,
not automatically.
