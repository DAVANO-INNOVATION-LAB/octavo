import base64, importlib.util, io, os, tempfile, unittest, zipfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('bridge', Path(__file__).resolve().parents[1]/'integrations/skypilot/bridge.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
class SourcePolicy(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();b.ROOT=Path(self.tmp.name).resolve()/'jobs';b.SOURCE_ROOT=Path(self.tmp.name).resolve()/'sources';b.SOURCE_ROOT.mkdir();(b.SOURCE_ROOT/'ok').mkdir()
 def tearDown(self): self.tmp.cleanup()
 def test_local(self): self.assertEqual(b.prepare_source({'type':'local','path':'ok'},'one'),str(b.SOURCE_ROOT/'ok'))
 def test_escape(self):
  with self.assertRaises(ValueError): b.prepare_source({'type':'local','path':'..'},'one')
 def test_symlink(self):
  (b.SOURCE_ROOT/'ok'/'link').symlink_to('/etc/hosts')
  with self.assertRaises(ValueError): b.prepare_source({'type':'local','path':'ok'},'one')
 def test_git_policy(self):
  for url,commit in [('https://evil.test/repo','a'*40),('https://github.com/repo','main'),('https://secret@github.com/repo','a'*40)]:
   with self.assertRaises(ValueError): b.prepare_source({'type':'git','url':url,'commit':commit},'one')
 def test_zip(self):
  for name,valid in [('main.py',True),('../escape',False),('/absolute',False)]:
   stream=io.BytesIO()
   with zipfile.ZipFile(stream,'w') as z:z.writestr(name,'print(42)')
   source={'type':'archive','base64':base64.b64encode(stream.getvalue()).decode()}
   if valid:self.assertTrue(Path(b.prepare_source(source,'one'),'main.py').exists())
   else:
    with self.assertRaises(ValueError):b.prepare_source(source,'one')
 def test_persistence(self):
  with b.database() as db:db.execute('INSERT INTO jobs(id,spec,state,output) VALUES(?,?,?,?)',('one','{}','QUEUED',''))
  b.update('one','RUNNING',[7],'accepted');self.assertEqual(b.row('one')[3],'[7]')
  b.update('one','SUCCEEDED',output='done');self.assertEqual(b.row('one')[3],'[7]')
if __name__=='__main__':unittest.main()
