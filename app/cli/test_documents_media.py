import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import attachments
import instructions
from test_dispatch import dispatch


class Media(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.home=Path(self.tmp.name)
        self.ref={'agent':'codex','path':str(self.home/'trace.jsonl'),'cwd':str(self.home)}
    def transcript(self, content):
        Path(self.ref['path']).write_text(json.dumps({'type':'response_item','timestamp':'2026-09-06','payload':{'type':'message','role':'assistant','content':content}})+'\n')
    def test_local_image_and_mime_sniff(self):
        p=self.home/'shot.png';p.write_bytes(b'\xff\xd8\xfftest');self.transcript([{'type':'output_text','text':f'![Shot]({p})'}])
        a=attachments.catalog(self.ref);self.assertEqual(len(a),1)
        self.assertEqual(attachments.read(self.ref,a[0]['id'])['mime'],'image/jpeg')
    def test_embedded_image(self):
        self.transcript([{'type':'input_image','image_url':'data:image/png;base64,'+base64.b64encode(b'image').decode()}])
        self.assertEqual(base64.b64decode(attachments.read(self.ref,attachments.catalog(self.ref)[0]['id'])['data']),b'image')
    def test_unlinked_file_denied(self):
        self.transcript([{'type':'output_text','text':'No attachment'}])
        with self.assertRaises(ValueError):attachments.read(self.ref,str(self.home/'private.md'))
    def test_tool_arguments_not_attachments(self):
        Path(self.ref['path']).write_text(json.dumps({'type':'response_item','payload':{'type':'function_call','name':'read','arguments':str(self.home/'secret.md')}}))
        self.assertEqual(attachments.catalog(self.ref),[])
    def test_missing_file_explained(self):
        self.transcript([{'type':'output_text','text':'[file](missing.pdf)'}])
        self.assertFalse(attachments.catalog(self.ref)[0]['exists'])
        with self.assertRaisesRegex(ValueError,'移动'):attachments.read(self.ref,'missing.pdf')
    def test_artifact_embeds_only_own_images(self):
        child=self.home/'artifact';child.mkdir();(child/'ok.png').write_bytes(b'\x89PNG\r\ntest');(self.home/'outside.png').write_bytes(b'private')
        result=attachments.portable_html('<h1>Artifact</h1><img src="ok.png"><img src="../outside.png"><img src="https://x/y.png">',child)
        self.assertIn('data:image/png;base64,',result);self.assertIn('../outside.png',result);self.assertNotIn(base64.b64encode(b'private').decode(),result)


class Documents(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.home=Path(self.tmp.name)
        (self.home/'.codex').mkdir();(self.home/'.claude').mkdir();self.doc=self.home/'.codex/AGENTS.md'
        self.doc.write_text('# Rules\n- Always run relevant tests before delivery.\n')
    def proposal(self,content):
        return {'path':str(self.doc),'content':content,'hashes':instructions.plan(self.home,str(self.doc),content)['hashes']}
    def test_override_and_references(self):
        (self.home/'.codex/AGENTS.override.md').write_text('See [common](../common.md)');(self.home/'common.md').write_text('General rules')
        inv=instructions.inventory(self.home);by={d['path']:d for d in inv['documents']}
        self.assertFalse(by[str(self.doc)]['active']);self.assertIn(str(self.home/'common.md'),by)
    def test_duplicate_conflict_reference_cycle(self):
        self.doc.write_text('- Always run relevant tests before delivery.\n- Always run relevant tests before delivery.\n@../common.md\n@missing.md\n')
        (self.home/'common.md').write_text('- Never run relevant tests before delivery.\n@.codex/AGENTS.md')
        kinds={f['kind'] for f in instructions.audit(instructions.inventory(self.home))['findings']}
        self.assertTrue({'duplicate','conflict','reference','cycle'}<=kinds)
    def test_apply_restore_keeps_symlink(self):
        actual=self.home/'real.md';self.doc.rename(actual);self.doc.symlink_to(actual)
        before=actual.read_text();result=instructions.apply(self.home,self.proposal(before+'- Keep changes focused.\n'))
        self.assertTrue(self.doc.is_symlink());instructions.restore(self.home,result['backup']);self.assertEqual(actual.read_text(),before)
    def test_stale_preview_rejected(self):
        payload=self.proposal('new content');self.doc.write_text('Changed elsewhere')
        with self.assertRaisesRegex(ValueError,'其他程序'):instructions.apply(self.home,payload)
        self.assertEqual(self.doc.read_text(),'Changed elsewhere')
    def test_restore_does_not_overwrite_later_edit(self):
        result=instructions.apply(self.home,self.proposal('New rules'));self.doc.write_text('Later edit')
        with self.assertRaisesRegex(ValueError,'又有修改'):instructions.restore(self.home,result['backup'])
        self.assertEqual(self.doc.read_text(),'Later edit')
    def test_managed_block_cannot_be_edited(self):
        block=f'{instructions.BEGIN} hash:123 source:/missing -->\nManaged\n{instructions.END}'
        self.doc.write_text(block)
        with self.assertRaisesRegex(ValueError,'托管块'):instructions.plan(self.home,str(self.doc),block.replace('Managed','Changed'))
    def test_source_change_updates_consumers(self):
        root=self.home/'.agents/rules/GLOBAL.md';root.parent.mkdir(parents=True);root.write_text('Shared\n')
        self.doc.write_text(f'{instructions.BEGIN} hash:old source:{root} -->\nShared\n{instructions.END}\n')
        p=instructions.plan(self.home,str(root),'Updated shared\n');self.assertEqual(len(p['changes']),2)
        self.assertIn('Updated shared',next(c['after'] for c in p['changes'] if c['path']==str(self.doc)))
    def test_tidy_preserves_fences_and_managed_blocks(self):
        content='- same rule\n- same rule\n```\n- same code\n- same code\n```\n'+instructions.BEGIN+' -->\n- managed\n- managed\n'+instructions.END+'\n'
        result=instructions.tidy(content);self.assertEqual(result.count('- same rule'),1);self.assertEqual(result.count('- same code'),2);self.assertEqual(result.count('- managed'),2)
    def test_model_profiles_are_explicit(self):
        inv=instructions.inventory(self.home)
        self.assertEqual(instructions.audit(inv,model='gpt-6-astra')['profile'],'codex')
        self.assertEqual(instructions.audit(inv,model='claude-sonnet-5')['profile'],'claude')
        self.assertEqual(instructions.audit(inv,model='custom-local')['profile'],'general')

    def test_project_scope_apply_keeps_global_and_other_projects(self):
        root=self.home/'project';root.mkdir();local=root/'AGENTS.md';local.write_text('Project rules')
        other=self.home/'other';other.mkdir();(other/'AGENTS.md').write_text('Other rules')
        original=self.doc.read_text()
        p=instructions.plan(self.home,str(local),'Updated project rules',project=root)
        self.assertNotIn(str(other/'AGENTS.md'),p['hashes'])
        result=instructions.apply(self.home,{'path':str(local),'content':'Updated project rules','hashes':p['hashes']},project=root)
        self.assertEqual(local.read_text(),'Updated project rules')
        self.assertEqual(self.doc.read_text(),original)
        self.assertEqual((other/'AGENTS.md').read_text(),'Other rules')
        instructions.restore(self.home,result['backup']);self.assertEqual(local.read_text(),'Project rules')
        (root/'AGENTS.override.md').write_text('Override')
        by={d['path']:d for d in instructions.inventory(self.home,project=root)['documents']}
        self.assertFalse(by[str(local)]['active']);self.assertTrue(by[str(self.doc)]['active'])


class TaskTrash(unittest.TestCase):
    def test_agent_qualified_session_key(self):
        with patch.object(dispatch,'session_refs',return_value=[{'agent':'codex'},{'agent':'claude-code'}]) as refs:
            self.assertEqual(dispatch.resolve({},'codex:abc'),[{'agent':'codex'}]);refs.assert_called_once_with({},session_id='abc')
    def test_single_update_defers_and_remembers_status(self):
        from types import SimpleNamespace
        with patch.object(dispatch,'bd_json',side_effect=[{'id':'t1','status':'in_progress','labels':[]},{}]) as bd, patch.object(dispatch,'out'):
            dispatch.cmd_task(SimpleNamespace(op='trash',task='t1',json=True))
        args=bd.call_args_list[-1].args[0];self.assertIn('deferred',args);self.assertIn('dispatch:previous:in_progress',args)
    def test_restore_recovers_previous_status(self):
        from types import SimpleNamespace
        with patch.object(dispatch,'bd_json',side_effect=[{'id':'t1','status':'deferred','labels':['dispatch:trashed','dispatch:previous:blocked']},{}]) as bd, patch.object(dispatch,'out'):
            dispatch.cmd_task(SimpleNamespace(op='restore',task='t1',json=True))
        self.assertIn('blocked',bd.call_args_list[-1].args[0])


class HttpCommands(unittest.TestCase):
    def test_dispatch_bridge_preserves_stdin_host_and_actor(self):
        import serve
        with patch.object(serve,'sh',return_value='{}') as sh:
            serve.commands()['dispatch_on']({'host':'mini','args':['rules','check','--path','/a b.md'],'stdin':'hello\nworld'},'reader')
        self.assertIn('--host',sh.call_args.args[0]);self.assertIn('/a b.md',sh.call_args.args[0]);self.assertEqual(sh.call_args.kwargs['input'],'hello\nworld');self.assertEqual(sh.call_args.kwargs['env']['BEADS_ACTOR'],'reader')

class ProjectDocuments(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
    def write(self,rel,text='# Title\n'):
        p=self.root/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text);return p
    def test_kind_and_title(self):
        self.assertEqual(dispatch.docs_kind_of('oss-research-2026-09-09.md'),'调研')
        self.assertEqual(dispatch.docs_kind_of('review-2026-09-08.md'),'复审')
        self.assertEqual(dispatch.docs_kind_of('调研报告.md'),'调研')
        self.assertEqual(dispatch.docs_kind_of('ui-mockup.html'),'文档')
        p=self.write('design/a.md','\n\n# 真标题\nbody\n');self.assertEqual(dispatch.docs_title(str(p)),'真标题')
        h=self.write('design/b.html','<html><head><title>页面标题</title></head></html>');self.assertEqual(dispatch.docs_title(str(h)),'页面标题')
        self.assertEqual(dispatch.docs_title(str(self.write('design/c.md','no heading\n'))),'c')
    def test_scan_depth_and_skips(self):
        self.write('design/top.md');self.write('design/sub/one.md');self.write('design/sub/deep/two.md');self.write('design/sub/deep/deeper/three.md')
        self.write('design/node_modules/pkg/x.md');self.write('design/shot.png');self.write('other/not.md')
        rows=dispatch.docs_scan([str(self.root)])
        self.assertEqual(sorted(os.path.basename(r['path']) for r in rows),['one.md','top.md','two.md'])
        self.assertTrue(all(r['id'] for r in rows))
    def test_merge_prefers_registration_and_sorts(self):
        p=self.write('design/old.md','# Scanned\n');os.utime(p,(100,100))
        scanned=dispatch.docs_scan([str(self.root)])
        reg=dispatch.docs_registered_rows([{'id':'x','path':str(p),'title':'登记标题','kind':'设计','added_at':200}])
        rows=dispatch.docs_merge(scanned,reg)
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['title'],'登记标题');self.assertEqual(rows[0]['kind'],'设计');self.assertEqual(rows[0]['source'],'registered')
        u=dispatch.docs_registered_rows([{'id':'y','path':'https://example.com/paper.md','title':'','kind':'','added_at':300}])
        rows=dispatch.docs_merge(scanned,u)
        self.assertEqual(rows[0]['path'],'https://example.com/paper.md');self.assertTrue(rows[0]['url']);self.assertEqual(rows[0]['kind'],'其他')
    def test_register_and_remove_roundtrip(self):
        p=self.write('design/research-2026.md','# 调研\n')
        store={}
        def save(project,entries): store[project]=list(entries)
        def load(project): return store.get(project,[])
        with patch.object(dispatch,'docs_registered',side_effect=load),patch.object(dispatch,'docs_save',side_effect=save):
            row=dispatch.docs_register('Proj',str(p))
            self.assertEqual(row['kind'],'调研');self.assertEqual(store['Proj'][0]['id'],row['id'])
            self.assertTrue(dispatch.docs_unregister('Proj',row['id']))
            self.assertFalse(dispatch.docs_unregister('Proj','nope'))
            self.assertEqual(store['Proj'],[])
    def test_read_markdown_html_and_asset(self):
        p=self.write('design/read-me.md','# 读我\n![shot](screenshots/shot.png)\n')
        (self.root/'design/screenshots').mkdir();(self.root/'design/screenshots/shot.png').write_bytes(b'\x89PNG\r\nimg')
        html=self.write('design/page.html','<title>Page</title>')
        with patch.object(dispatch,'docs_list',return_value=[{'id':'m','path':str(p),'title':'读我','kind':'文档','url':False},{'id':'h','path':str(html),'title':'Page','kind':'文档','url':False}]):
            md=dispatch.docs_read('P','m');self.assertIn('读我',md['text']);self.assertFalse(md['html'])
            hp=dispatch.docs_read('P','h');self.assertTrue(hp['html']);self.assertEqual(hp['text'],'')
            a=dispatch.docs_read('P','m','screenshots/shot.png');self.assertTrue(a['data']);self.assertEqual(a['mime'],'image/png')
        with self.assertRaises(ValueError): dispatch.docs_asset(str(p),'../../etc/passwd')


if __name__=='__main__':unittest.main()
