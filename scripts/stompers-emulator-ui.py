#!/usr/bin/env python3
"""Local, single-emulator controls. Never logs typed text or screen contents."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import secrets
import shlex
import subprocess
import threading
from urllib.parse import urlsplit


PAGE = r'''<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stompers test phone</title>
<style>
:root {color-scheme: light dark; font-family: system-ui, sans-serif;}
body {max-width: 650px; margin: 20px auto; padding: 0 16px;}
button,input {font: inherit; padding: 8px; margin: 4px;}
#phone {display: block; max-width: 100%; max-height: 65vh; touch-action: none;
 border: 1px solid GrayText; margin: 12px auto;}
form {display: flex; flex-wrap: wrap; align-items: center;}
input {flex: 1; min-width: 150px;}
#status {min-height: 1.5em;}
</style>
<h1>Stompers test phone</h1>
<p>Tap the screen. Drag to scroll. Use the box to type.</p>
<p>Enter login here, never in chat. Typed text is not logged.</p>
<button id="refresh">Refresh screen</button>
<button data-key="back">Back</button><button data-key="home">Home</button>
<button data-key="enter">Enter</button><button data-key="delete">Delete</button>
<form id="typing"><label for="text">Type:</label>
<input id="text" type="password" autocomplete="off" spellcheck="false"
 placeholder="Phone number, email, or code" maxlength="256">
<button>Send text</button></form>
<p id="status" role="status">Loading phone…</p>
<img id="phone" alt="Android screen">
<script>
const csrf = '__CSRF__';
const phone = document.querySelector('#phone');
const status = document.querySelector('#status');
let busy = false, oldURL;
async function screen() {
  if (busy) return;
  busy = true;
  try {
    status.textContent = 'Reading screen…';
    const r = await fetch('screen', {cache: 'no-store'});
    if (!r.ok) throw Error('Phone is busy. Try Refresh screen.');
    const url = URL.createObjectURL(await r.blob());
    phone.src = url;
    if (oldURL) URL.revokeObjectURL(oldURL);
    oldURL = url; status.textContent = 'Ready';
  } catch (e) { status.textContent = e.message; }
  finally { busy = false; }
}
async function action(body) {
  if (busy) return;
  busy = true; status.textContent = 'Sending…';
  try {
    const r = await fetch('action', {method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Control-Key': csrf},
      body: JSON.stringify(body)});
    if (!r.ok) throw Error(await r.text());
    status.textContent = 'Sent. Waiting for phone…';
    setTimeout(screen, 1200);
  } catch (e) { status.textContent = e.message; }
  finally { busy = false; }
}
document.querySelector('#refresh').onclick = screen;
document.querySelectorAll('[data-key]').forEach(b =>
  b.onclick = () => action({kind: 'key', key: b.dataset.key}));
document.querySelector('#typing').onsubmit = e => {
  e.preventDefault();
  const input = document.querySelector('#text'), text = input.value;
  input.value = ''; action({kind: 'text', text});
};
function point(e) {
  const r = phone.getBoundingClientRect();
  return [Math.round((e.clientX-r.left)*phone.naturalWidth/r.width),
          Math.round((e.clientY-r.top)*phone.naturalHeight/r.height)];
}
let start;
phone.onpointerdown = e => {start = point(e); phone.setPointerCapture(e.pointerId);};
phone.onpointerup = e => {
  if (!start) return;
  const end = point(e), distance = Math.hypot(end[0]-start[0],end[1]-start[1]);
  action(distance < 15 ? {kind: 'tap', x: end[0], y: end[1]} :
    {kind: 'swipe', x: start[0], y: start[1], endx: end[0], endy: end[1]});
  start = null;
};
screen();
</script></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', required=True)
    parser.add_argument('--port', type=int, default=8087)
    parser.add_argument('--public-origin', help='HTTPS origin of an authenticated reverse proxy')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Choose a port from 1024 through 65535.')
    csrf = secrets.token_urlsafe(32)
    lock = threading.Lock()
    hosts = {f'127.0.0.1:{args.port}', f'localhost:{args.port}'}
    origins = {f'http://{host}' for host in hosts}
    if args.public_origin:
        origin = urlsplit(args.public_origin)
        if (origin.scheme != 'https' or not origin.hostname
                or origin.username or origin.password or origin.path
                or origin.query or origin.fragment):
            parser.error('--public-origin must be an HTTPS origin without a path or credentials.')
        hosts.add(origin.netloc)
        origins.add(args.public_origin)

    def adb(*command, script=None):
        with lock:
            stdin = {'stdin': subprocess.DEVNULL} if script is None else {'input': script}
            result = subprocess.run(
                [args.adb, '-P', '5038', '-s', 'emulator-5556', *command],
                **stdin, capture_output=True, timeout=40,
            )
        if result.returncode:
            raise RuntimeError('Phone command failed. Try again after boot.')
        return result.stdout

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # No access logs: typed text and screen data stay private.

        def reply(self, code, data, content_type='text/plain; charset=utf-8'):
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy',
                             "default-src 'self'; img-src 'self' blob:; "
                             "script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                             "base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(data)

        def allowed(self):
            return self.headers.get('Host') in hosts

        def do_GET(self):
            if not self.allowed():
                return self.reply(403, b'Wrong host.')
            if self.path == '/':
                return self.reply(200, PAGE.replace('__CSRF__', csrf).encode(),
                                  'text/html; charset=utf-8')
            if self.path == '/screen':
                if self.headers.get('Sec-Fetch-Site') == 'cross-site':
                    return self.reply(403, b'Use the local page.')
                try:
                    png = adb('exec-out', 'screencap', '-p')
                    if not png.startswith(b'\x89PNG\r\n\x1a\n'):
                        raise RuntimeError('Screen is not ready.')
                    return self.reply(200, png, 'image/png')
                except (RuntimeError, subprocess.TimeoutExpired):
                    return self.reply(503, b'Screen is not ready. Try again.')
            self.reply(404, b'Not found.')

        def do_POST(self):
            if (not self.allowed() or self.path != '/action'
                    or self.headers.get('Origin') not in origins
                    or not secrets.compare_digest(
                        self.headers.get('X-Control-Key', ''), csrf)):
                return self.reply(403, b'Use the local page.')
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 4096:
                    raise ValueError()
                data = json.loads(self.rfile.read(size))
                kind = data['kind']
                if kind in ('tap', 'swipe'):
                    keys = ('x', 'y') if kind == 'tap' else ('x', 'y', 'endx', 'endy')
                    coords = [data[k] for k in keys]
                    if any(type(v) is not int or not 0 <= v < 4096 for v in coords):
                        raise ValueError()
                    command = ['input', kind, *map(str, coords)]
                    if kind == 'swipe':
                        command.append('400')
                elif kind == 'key':
                    key = {'back': '4', 'home': '3', 'enter': '66', 'delete': '67'}[data['key']]
                    command = ['input', 'keyevent', key]
                elif kind == 'text':
                    text = data['text']
                    if not isinstance(text, str) or not re.fullmatch(r'[ -~]{1,256}', text):
                        return self.reply(400, b'Use printable ASCII letters, numbers, and symbols.')
                    # Android interprets "%s" as a space. Split literal pairs
                    # before converting real spaces, preserving passwords.
                    chunks = re.split(r'(?<=%)(?=s)', text)
                    script = '\n'.join(shlex.join(['input', 'text', chunk.replace(' ', '%s')])
                                       for chunk in chunks) + '\n'
                    # Send text over stdin, not host process arguments.
                    adb('shell', 'sh', script=script.encode())
                    return self.reply(200, b'OK')
                else:
                    raise ValueError()
                adb('shell', 'sh', script=(shlex.join(command) + '\n').encode())
                self.reply(200, b'OK')
            except (KeyError, ValueError, TypeError):
                self.reply(400, b'Bad control request.')
            except (RuntimeError, subprocess.TimeoutExpired):
                self.reply(503, b'Phone is busy. Try again.')

    print(f'Local emulator controls: http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
