import base64
import importlib.util
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / 'server'))
import guest


class GuestTests(unittest.TestCase):
    def fixture(self):
        raw = bytes.fromhex('0000000b7373682d6564323535313900000020') + bytes(32)
        return {'id': 'alice', 'address': '8.8.4.4', 'sshPort': 22,
                'publicKey': 'ssh-ed25519 ' + base64.b64encode(raw).decode() + ' fixture'}

    def test_valid_request_and_reject_path_or_key_injection(self):
        self.assertEqual(guest.validate_request(self.fixture())['id'], 'alice')
        for patch in ({'id': '../root'}, {'address': '127.0.0.1'}, {'sshPort': 0},
                      {'publicKey': 'ssh-ed25519 AAAA'}, {'publicKey': self.fixture()['publicKey'] + '\ncommand=evil'}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                guest.validate_request({**self.fixture(), **patch})

    def test_forced_export_blocks_shell_admin_forwards_remote_and_unix_sockets(self):
        text = guest.ssh_match('csg-alice', 8080, '/var/lib/cloud-stack-access/alice')
        self.assertIn('ForceCommand /bin/cat /var/lib/cloud-stack-access/alice/client.json', text)
        self.assertIn('PermitOpen 127.0.0.1:8080', text)
        self.assertNotIn('2095', text)
        for line in ('AllowTcpForwarding local', 'PermitListen none', 'AllowStreamLocalForwarding no',
                     'PermitTTY no', 'PermitTunnel no', 'AllowAgentForwarding no', 'PermitUserRC no'):
            self.assertIn(line, text)
        self.assertTrue(text.endswith('Match all\n'))

    def test_import_has_no_provisioning_side_effect(self):
        self.assertTrue(callable(guest.provision))
        self.assertTrue(callable(guest.revoke))


if __name__ == '__main__':
    unittest.main()
