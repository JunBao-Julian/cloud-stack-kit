#!/usr/bin/env python3
"""Add/revoke one restricted guest on an EXISTING native CloudStack server.

No service installation, panel template changes, or owner credential export.
"""
import base64
import hashlib
import ipaddress
import json
import os
import pathlib
import pwd
import re
import secrets
import sqlite3
import sys
import urllib.request
from contextlib import closing
import server as stack

ROOT = pathlib.Path('/var/lib/cloud-stack-guests')


def change_api(panel, endpoint, method, data=None):
    req = urllib.request.Request(f'http://127.0.0.1:{panel.c["server"]["apiPort"]}/api/v1' + endpoint,
        method=method, data=json.dumps(data).encode() if data is not None else None,
        headers={'Authorization': 'Bearer ' + panel.token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=25) as response:
        value = json.load(response)
    if value.get('code', 0) != 0:
        raise RuntimeError('Sub2API mutation failed: ' + endpoint)
    return value.get('data', value)


def validate_request(r):
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,18}', r.get('id', '')):
        raise ValueError('Guest ID must be 2-19 lowercase letters/digits/hyphens')
    if not ipaddress.IPv4Address(r['address']).is_global:
        raise ValueError('A public server IPv4 is required')
    if type(r['sshPort']) is not int or not 0 < r['sshPort'] < 65536:
        raise ValueError('Invalid SSH port')
    key = r.get('publicKey', '')
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [A-Za-z0-9-]+)?', key):
        raise ValueError('Invalid guest public key')
    raw = base64.b64decode(key.split()[1], validate=True)
    if len(raw) != 51 or raw[:19] != b'\0\0\0\x0bssh-ed25519\0\0\0\x20':
        raise ValueError('Invalid Ed25519 key encoding')
    return r


def existing(r):
    state = pathlib.Path('/var/lib/cloud-stack')
    if (state / 'credentials.json').is_file():
        c = json.loads((state / 'config.json').read_text())
        s = json.loads((state / 'credentials.json').read_text())
        if c['server']['address'] != r['address']:
            raise RuntimeError('Server address does not match existing deployment')
    else:
        c = {'instanceId': 'guest-check', 'server': {'address': r['address'],
             'proxyPort': 24443, 'apiPort': 8080, 'suiPort': 2095, 'subPort': 2096}}
        s = stack.read_legacy(c)
    for service in ('s-ui', 'sub2api', 'ssh'):
        stack.run(['systemctl', 'is-active', '--quiet', service])
    with closing(sqlite3.connect('file:/usr/local/s-ui/db/s-ui.db?mode=ro', uri=True)) as db:
        rows = []
        for ident, kind, options in db.execute('SELECT id,type,options FROM inbounds'):
            opt = json.loads(options)
            if kind == 'shadowsocks' and opt.get('method') == '2022-blake3-aes-128-gcm' and opt.get('password') == s['ssServerKey'] and opt.get('listen_port') == c['server']['proxyPort']:
                rows.append(ident)
        if len(rows) != 1:
            raise RuntimeError('Expected exactly one matching existing SS2022 inbound')
    return c, s, rows[0]


def ssh_match(user, port, home):
    return (f'Match User {user}\n'
            f'    AuthorizedKeysFile {home}/authorized_keys\n'
            f'    ForceCommand /bin/cat {home}/client.json\n'
            '    AuthenticationMethods publickey\n'
            '    PasswordAuthentication no\n'
            '    KbdInteractiveAuthentication no\n'
            '    AllowTcpForwarding local\n'
            f'    PermitOpen 127.0.0.1:{port}\n'
            '    PermitListen none\n'
            '    AllowStreamLocalForwarding no\n'
            '    PermitTTY no\n'
            '    PermitTunnel no\n'
            '    X11Forwarding no\n'
            '    AllowAgentForwarding no\n'
            '    PermitUserRC no\nMatch all\n')


def provision(r):
    validate_request(r)
    c, owner, inbound = existing(r)
    panel = stack.Panel(c, owner)
    login = panel.api('/auth/login', {'email': owner['sub2apiAdminEmail'], 'password': owner['sub2apiAdminPassword']})
    panel.token = login['access_token']
    if panel.api('/admin/compliance').get('required'):
        raise RuntimeError('Owner must accept the deployment notice in the existing panel first')
    panel.sui('login', {'user': owner['suiUser'], 'pass': owner['suiPassword']})
    ROOT.mkdir(mode=0o700, exist_ok=True)
    ROOT.chmod(0o700)
    record = ROOT / (r['id'] + '.json')
    if record.exists():
        data = json.loads(record.read_text())
        if data['publicKey'].split()[:2] != r['publicKey'].split()[:2] or data.get('revoked'):
            raise RuntimeError('Guest ID already exists with another key or was revoked; use a new ID')
    else:
        data = {'id': r['id'], 'publicKey': r['publicKey'], 'ssUserKey': base64.b64encode(secrets.token_bytes(16)).decode(), 'clientName': 'guest-' + r['id'] + '-' + secrets.token_hex(6)}
        stack.save(record, data)
    # A fresh exclusive group has NO owner upstreams and NO fallback group.
    # The owner must attach the friend's authorized upstream to this exact group.
    if 'groupId' not in data:
        group = panel.api('/admin/groups', {'name': 'Guest-' + r['id'], 'description': 'Separate upstream: guest ' + r['id'], 'platform': 'anthropic', 'rate_multiplier': 1, 'subscription_type': 'standard', 'is_exclusive': True})
        data['groupId'] = group['id']
        stack.save(record, data)
    if 'apiKey' not in data:
        # Exclusive groups require an explicit grant even for the key's owner.
        user = panel.api('/admin/users/' + str(login['user']['id']))
        allowed = user.get('allowed_groups') or []
        if data['groupId'] not in allowed:
            change_api(panel, '/admin/users/' + str(user['id']), 'PUT', {'allowed_groups': allowed + [data['groupId']]})
        key = panel.api('/keys', {'name': 'Guest-' + r['id'], 'group_id': data['groupId'], 'ip_whitelist': ['127.0.0.1/32', '::1/128']})
        data.update(apiKey=key['key'], apiKeyId=key['id'])
        stack.save(record, data)
    clients = panel.sui('clients')['clients']
    found = next((x for x in clients if x.get('name') == data['clientName']), None)
    if not found:
        panel.sui('save', {'object': 'clients', 'action': 'new', 'data': json.dumps({'enable': True, 'name': data['clientName'], 'remark': 'Guest-' + r['id'], 'inbounds': [inbound], 'volume': 0, 'expiry': 0, 'config': {'shadowsocks16': {'name': data['clientName'], 'password': data['ssUserKey']}}, 'links': []})})
        found = next(x for x in panel.sui('clients')['clients'] if x.get('name') == data['clientName'])
    data['suiClientId'] = found['id']
    user = 'csg-' + r['id']
    home = pathlib.Path('/var/lib/cloud-stack-access') / r['id']
    home.parent.mkdir(mode=0o755, exist_ok=True)
    home.parent.chmod(0o755)
    home.mkdir(mode=0o750, exist_ok=True)
    try:
        account = pwd.getpwnam(user)
        if account.pw_dir != str(home) or account.pw_shell != '/bin/sh':
            raise RuntimeError('Existing Unix username is not owned by this kit')
    except KeyError:
        stack.run(['useradd', '--no-create-home', '--home-dir', str(home), '--shell', '/bin/sh', user])
        account = pwd.getpwnam(user)
    # Root owns the home/key/config; the guest cannot change the forced command.
    os.chown(home, 0, account.pw_gid)
    home.chmod(0o750)
    client = {'kind': 'guest', 'schemaVersion': 1, 'instanceId': 'guest-' + r['id'], 'serverAddress': r['address'], 'server': {**c['server'], 'sshPort': r['sshPort']}, 'sshUser': user, 'ssServerKey': owner['ssServerKey'], 'ssUserKey': data['ssUserKey'], 'sub2apiApiKey': data['apiKey'], 'groupId': data['groupId']}
    stack.save(home / 'client.json', client)
    keys = home / 'authorized_keys'
    keys.write_text(f'restrict,port-forwarding,permitopen="127.0.0.1:{c["server"]["apiPort"]}" {r["publicKey"]}\n')
    for f in (keys, home / 'client.json'):
        os.chown(f, 0, account.pw_gid)
        f.chmod(0o640)
    conf = pathlib.Path('/etc/ssh/sshd_config.d') / ('20-cloud-guest-' + r['id'] + '.conf')
    old = conf.read_text() if conf.exists() else None
    conf.write_text(ssh_match(user, c['server']['apiPort'], home))
    try:
        stack.run(['/usr/sbin/sshd', '-t'])
    except Exception:
        conf.write_text(old) if old is not None else conf.unlink()
        raise
    stack.run(['systemctl', 'reload', 'ssh'])
    data.update(user=user, home=str(home))
    stack.save(record, data)
    host_key = pathlib.Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()
    host_public = ' '.join(host_key[:2])
    fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(base64.b64decode(host_key[1])).digest()).decode().rstrip('=')
    return {'schemaVersion': 1, 'id': r['id'], 'address': r['address'], 'sshPort': r['sshPort'], 'username': user, 'hostPublicKey': host_public, 'hostFingerprint': fingerprint, 'groupId': data['groupId'], 'keyFile': 'guest_key'}


def revoke(r):
    validate_request(r)
    record = ROOT / (r['id'] + '.json')
    data = json.loads(record.read_text())
    c, owner, _ = existing(r)
    # Disable SSH first, including established sessions. Never touch another user.
    user = 'csg-' + r['id']
    keys = pathlib.Path('/var/lib/cloud-stack-access') / r['id'] / 'authorized_keys'
    if keys.exists():
        keys.write_text('')
    import subprocess
    subprocess.run(['pkill', '-KILL', '-u', user], check=False)
    panel = stack.Panel(c, owner)
    panel.token = panel.api('/auth/login', {'email': owner['sub2apiAdminEmail'], 'password': owner['sub2apiAdminPassword']})['access_token']
    if not data.get('keyRevoked'):
        change_api(panel, '/keys/' + str(data['apiKeyId']), 'DELETE')
        data['keyRevoked'] = True
        stack.save(record, data)
    panel.sui('login', {'user': owner['suiUser'], 'pass': owner['suiPassword']})
    clients = panel.sui('clients')['clients']
    if any(x['id'] == data['suiClientId'] for x in clients):
        panel.sui('save', {'object': 'clients', 'action': 'del', 'data': json.dumps(data['suiClientId'])})
    data['revoked'] = True
    stack.save(record, data)
    return {'revoked': True, 'id': r['id']}


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise RuntimeError('Owner provisioning requires root SSH')
        request = json.loads(pathlib.Path(sys.argv[2]).read_text())
        result = revoke(request) if sys.argv[1] == 'revoke' else provision(request)
        print(json.dumps(result))
    except Exception as error:
        # Never dump HTTP bodies or owner credentials on an error.
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
