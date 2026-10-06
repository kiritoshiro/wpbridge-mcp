#!/usr/bin/env python3
"""WordPress Playground smoke test.

Boots a throwaway WordPress with WordPress Playground, mounts this repository's
plugin(s) or theme, activates them, adds a fixture page, then logs in and loads
the front end and every wp-admin menu page. It fails when activation fails, a
page does not answer 200, a page shows a PHP error or WordPress's "critical
error" screen, or debug.log has a PHP error, warning, notice or deprecation from
a watched path (this repository's code).

Usage: python3 .github/playground/smoke.py [--php 8.4] [--wp latest]
Configuration: .github/playground/config.json (see the comment block there).
"""
import argparse
import html
import http.cookiejar
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

CLI = "@wp-playground/cli@3.1.57"
PORT = 9400
BASE = f"http://127.0.0.1:{PORT}"
# Playground's built-in administrator (throwaway site, never a real account).
USER, PASSWORD = "admin", "password"
PHP_LOG_LINE = re.compile(r"PHP (Fatal error|Parse error|Warning|Notice|Deprecated|Recoverable fatal error)", re.I)
PAGE_ERROR = re.compile(r"<b>(Fatal error|Parse error|Warning|Notice|Deprecated)</b>:|There has been a critical error on this website", re.I)
ADMIN_SKIP = re.compile(r"(customize\.php|site-editor\.php|wp-login\.php|action=logout|update-core\.php|plugin-install\.php|theme-install\.php)")

failures = []


def fail(message):
    failures.append(message)
    print(f"::error::{message}")


class MenuLinks(HTMLParser):
    """Collect hrefs inside the wp-admin menu (<ul id="adminmenu">)."""

    def __init__(self):
        super().__init__()
        self.depth = 0
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "ul" and attrs.get("id") == "adminmenu":
            self.depth = 1
        elif self.depth and tag == "ul":
            self.depth += 1
        elif self.depth and tag == "a" and attrs.get("href"):
            self.links.append(html.unescape(attrs["href"]))

    def handle_endtag(self, tag):
        if self.depth and tag == "ul":
            self.depth -= 1


def blueprint(config, logs_vfs):
    steps = [{
        "step": "defineWpConfigConsts",
        "consts": {
            "WP_DEBUG": True,
            "WP_DEBUG_LOG": f"{logs_vfs}/debug.log",
            "WP_DEBUG_DISPLAY": False,
            "SCRIPT_DEBUG": False,
        },
    }]
    steps += config.get("setup", [])
    for plugin in config.get("plugins", []):
        steps.append({"step": "activatePlugin", "pluginPath": plugin})
    if config.get("theme"):
        steps.append({"step": "activateTheme", "themeFolderName": config["theme"]})
    fixture = config.get("fixture")
    if fixture:
        steps.append({"step": "runPHP", "code": (
            "<?php require '/wordpress/wp-load.php';"
            "$id = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish',"
            " 'post_name' => 'playground-smoke', 'post_title' => 'Playground smoke test',"
            f" 'post_content' => {json.dumps(fixture)}]);"
            "if (is_wp_error($id) || ! $id) { throw new Exception('fixture page was not created'); }"
        )})
    return {"$schema": "https://playground.wordpress.net/blueprint-schema.json", "steps": steps}


def start_server(args, config, root, logs_dir, workdir):
    bp_path = os.path.join(workdir, "blueprint.json")
    with open(bp_path, "w", encoding="utf-8") as fh:
        json.dump(blueprint(config, "/logs"), fh, indent=2)
    cmd = ["npx", "--yes", CLI, "server", f"--port={PORT}", f"--php={args.php}", f"--wp={args.wp}",
           f"--blueprint={bp_path}", "--mount-dir", logs_dir, "/logs"]
    for mount in config["mounts"]:
        cmd += ["--mount-dir", os.path.abspath(os.path.join(root, mount["host"])), mount["vfs"]]
    print("+ " + " ".join(cmd), flush=True)
    # A new process group/session, so stop_server() also stops the node
    # process that npx starts.
    extra = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace", shell=os.name == "nt", **extra)
    ready = threading.Event()
    output = []

    def pump():
        for line in proc.stdout:
            output.append(line)
            print("  | " + line.rstrip(), flush=True)
            if "Ready!" in line:
                ready.set()

    threading.Thread(target=pump, daemon=True).start()
    deadline = time.time() + args.boot_timeout
    while time.time() < deadline and not ready.is_set() and proc.poll() is None:
        time.sleep(1)
    if not ready.is_set():
        stop_server(proc)
        sys.exit("::error::WordPress Playground did not start (blueprint or activation failed); see the log above")
    return proc


def stop_server(proc):
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            os.killpg(proc.pid, signal.SIGKILL)


def port_in_use():
    with socket.socket() as sock:
        return sock.connect_ex(("127.0.0.1", PORT)) == 0


def make_opener():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def get(opener, path, data=None):
    url = path if path.startswith("http") else BASE + path
    request = urllib.request.Request(url, data=data, headers={"User-Agent": "playground-smoke"})
    try:
        with opener.open(request, timeout=120) as resp:
            return resp.status, resp.geturl(), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, url, err.read().decode("utf-8", "replace")


def check_page(opener, path, label=None):
    status, final, body = get(opener, path)
    label = label or path
    if status != 200:
        fail(f"{label}: HTTP {status}")
    elif PAGE_ERROR.search(body):
        fail(f"{label}: page shows a PHP error or the critical-error screen")
    else:
        print(f"ok  {status} {label}")
    return body


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--php", default="8.4")
    parser.add_argument("--wp", default="latest")
    parser.add_argument("--config", default=".github/playground/config.json")
    parser.add_argument("--boot-timeout", type=int, default=420)
    args = parser.parse_args()

    root = os.getcwd()
    with open(args.config, encoding="utf-8") as fh:
        config = json.load(fh)
    workdir = tempfile.mkdtemp(prefix="playground-smoke-")
    logs_dir = os.path.join(workdir, "logs")
    os.makedirs(logs_dir)

    if port_in_use():
        sys.exit(f"::error::port {PORT} is already in use")
    proc = start_server(args, config, root, logs_dir, workdir)
    try:
        opener = make_opener()
        check_page(opener, "/", "front page")
        if config.get("fixture"):
            body = check_page(opener, "/?pagename=playground-smoke", "fixture page")
            for needle in config.get("expect", []):
                if needle not in body:
                    fail(f"fixture page: expected output not found: {needle!r}")

        get(opener, "/wp-login.php")  # sets the test cookie
        form = urllib.parse.urlencode({"log": USER, "pwd": PASSWORD, "wp-submit": "Log In",
                                       "redirect_to": BASE + "/wp-admin/", "testcookie": "1"}).encode()
        status, final, body = get(opener, "/wp-login.php", data=form)
        if "/wp-admin" not in final:
            sys.exit("::error::could not log in to the Playground site")

        plugins_page = check_page(opener, "/wp-admin/plugins.php", "plugins.php")
        for plugin in config.get("plugins", []):
            slug = plugin.split("/")[0]
            row = re.search(r'<tr class="([^"]*)"[^>]*data-slug="%s"' % re.escape(slug), plugins_page) \
                or re.search(r'<tr class="([^"]*)"[^>]*data-plugin="%s"' % re.escape(plugin), plugins_page)
            if not row or "inactive" in row.group(1).split() or "active" not in row.group(1).split():
                fail(f"{plugin} is not active")

        dashboard = check_page(opener, "/wp-admin/", "dashboard")
        menu = MenuLinks()
        menu.feed(dashboard)
        seen = set()
        for href in menu.links:
            url = urllib.parse.urljoin(BASE + "/wp-admin/", href)
            if not url.startswith(BASE + "/wp-admin/") or ADMIN_SKIP.search(url) or url in seen:
                continue
            seen.add(url)
            check_page(opener, url, url[len(BASE):])
        for extra in config.get("paths", []):
            check_page(opener, extra)
        print(f"Visited {len(seen)} admin menu pages.")
    finally:
        stop_server(proc)

    log_path = os.path.join(logs_dir, "debug.log")
    watch = config.get("watch", [])
    if os.path.exists(log_path):
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not PHP_LOG_LINE.search(line):
                    continue
                if any(w in line for w in watch):
                    fail("debug.log: " + line.strip()[:400])
                else:
                    print("::warning::debug.log (not this repository's code): " + line.strip()[:300])
    shutil.rmtree(workdir, ignore_errors=True)

    if failures:
        sys.exit(f"{len(failures)} smoke-test failure(s)")
    print("Playground smoke test passed.")


if __name__ == "__main__":
    main()
