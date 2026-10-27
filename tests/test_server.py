import importlib.util, io, json, pathlib, sqlite3, tarfile, tempfile, unittest
from unittest.mock import patch
from contextlib import closing
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('server',ROOT/'server'/'server.py')
server=importlib.util.module_from_spec(spec);spec.loader.exec_module(server)

class ServerTests(unittest.TestCase):
    def config(self):
        c=json.loads((ROOT/'config.example.json').read_text());c['server']['address']='8.8.4.4';return c
    def test_public_address_and_ports(self):
        self.assertEqual(server.validate(self.config())['server']['address'],'8.8.4.4')
        for ip in ['127.0.0.1','100.64.0.1','203.0.113.10','::1']:
            c=self.config();c['server']['address']=ip
            with self.assertRaises(ValueError):server.validate(c)
    def test_export_excludes_server_only_secrets(self):
        with tempfile.TemporaryDirectory() as d,patch.object(server,'STATE',pathlib.Path(d)):
            server.export(self.config(),{'instanceId':'test','dbPassword':'DO-NOT-EXPORT','jwt':'DO-NOT-EXPORT','ssUserKey':'TEST'})
            data=json.loads((pathlib.Path(d)/'client.json').read_text())
            self.assertNotIn('dbPassword',data);self.assertNotIn('jwt',data)
            self.assertEqual((pathlib.Path(d)/'client.json').stat().st_mode&0o777,0o600)
    def test_rejects_tar_traversal(self):
        with tempfile.TemporaryDirectory() as d:
            archive=pathlib.Path(d)/'bad.tar';dest=pathlib.Path(d)/'output'
            with tarfile.open(archive,'w') as t:
                info=tarfile.TarInfo('../escape');info.size=1;t.addfile(info,io.BytesIO(b'x'))
            with self.assertRaises(ValueError):server.extract(archive,dest)
            self.assertFalse((pathlib.Path(d)/'escape').exists())
    def test_compliance_requires_owner_and_never_writes(self):
        class FakePanel:
            def __init__(self,*a):self.token=None
            def api(self,endpoint,data=None):
                if endpoint=='/auth/login':return {'access_token':'TEST'}
                if endpoint=='/admin/compliance':return {'required':True}
                raise AssertionError('Mutation attempted before owner acceptance')
        with patch.object(server,'Panel',FakePanel):
            self.assertEqual(server.gateway(self.config(),{'sub2apiAdminEmail':'test','sub2apiAdminPassword':'test'}),3)
    def test_legacy_adoption_reads_exact_existing_node_and_rejects_different_server(self):
        c=self.config()
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);source=root/'credentials.json';dbpath=root/'s-ui.db';envpath=root/'sub2api.env'
            old={k:'TEST' for k in ['sub2api_email','sub2api_password','sui_user','sui_password','db_password','jwt','totp','ss_server_key','ss_user_key','subscription_id','sub2api_key']}
            source.write_text(json.dumps(old));envpath.write_text('SERVER_HOST=127.0.0.1\nSERVER_PORT=8080\n')
            with closing(sqlite3.connect(dbpath)) as db, db:
                db.execute('CREATE TABLE settings (key TEXT,value TEXT)')
                db.executemany('INSERT INTO settings VALUES (?,?)',[('webListen','127.0.0.1'),('subListen','127.0.0.1'),('webPort','2095'),('subPort','2096')])
                db.execute('CREATE TABLE inbounds (id INT,type TEXT,tag TEXT,options TEXT,out_json TEXT,addrs TEXT)')
                db.execute('INSERT INTO inbounds VALUES (?,?,?,?,?,?)',(1,'shadowsocks','Preserved-tag',json.dumps({'listen_port':24443,'password':'TEST','method':'2022-blake3-aes-128-gcm'}),json.dumps({'server':''}),json.dumps([{'server':'8.8.4.4','server_port':24443}])))
                db.execute('CREATE TABLE clients (name TEXT,config TEXT,inbounds TEXT)')
                db.execute('INSERT INTO clients VALUES (?,?,?)',('TEST',json.dumps({'shadowsocks16':{'password':'TEST'}}),'[1]'))
            s=server.read_legacy(c,source,dbpath,envpath)
            self.assertEqual(s['inboundTag'],'Preserved-tag');self.assertTrue(s['legacyAdopted']);self.assertEqual(s['sub2apiApiKey'],'TEST')
            c['server']['address']='8.8.8.8'
            with self.assertRaises(RuntimeError):server.read_legacy(c,source,dbpath,envpath)
    def test_existing_legacy_node_is_reused_without_duplicate_listener(self):
        writes=[]
        class FakePanel:
            def __init__(self,*a):pass
            def sui(self,endpoint,data=None):
                if endpoint=='login':return {}
                if endpoint=='inbounds':return {'inbounds':[{'id':1,'tag':'Existing-tag'}]}
                if endpoint=='clients':return {'clients':[{'name':'TEST-sub'}]}
                if endpoint=='save':writes.append(data['object']);return {}
                raise AssertionError(endpoint)
        c=self.config();c['clashTemplate']={}
        with patch.object(server,'Panel',FakePanel):server.configure_proxy(c,{'suiUser':'TEST','suiPassword':'TEST','inboundTag':'Existing-tag','subscriptionId':'TEST-sub'})
        self.assertEqual(writes,['settings'])

if __name__=='__main__':unittest.main()
