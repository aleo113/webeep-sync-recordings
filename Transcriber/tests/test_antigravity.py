import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.config import from_env
from src.notes_generator import _run_antigravity, generate_notes_markdown
from src.models import TranscriptResult
from src.worker import _options


def completed(response='# Notes', status='SUCCESS'):
    return subprocess.CompletedProcess([], 0, json.dumps({
        'event': 'result', 'result': {'status': status, 'response': response},
    }) + '\n', '')


class AntigravityTests(unittest.TestCase):
    def test_configuration_and_worker_preserve_provider_and_model(self):
        with patch.dict(os.environ, {'NOTES_PROVIDER': 'antigravity',
                                      'ANTIGRAVITY_BIN': '/custom/agy',
                                      'ANTIGRAVITY_MODEL': 'chosen-model'}, clear=True):
            config = from_env(None, None)
            self.assertEqual(config.notes_provider, 'antigravity')
            self.assertEqual(config.antigravity_bin, '/custom/agy')
            self.assertEqual(config.antigravity_model, 'chosen-model')
            self.assertEqual(from_env(None, None, explicit_antigravity_model='').antigravity_model, '')
        for model in ['', 'chosen-model']:
            options = _options({'workspace_root': '/work', 'output_root': '/out',
                                'notes_provider': 'antigravity', 'antigravity_model': model})
            self.assertEqual(options.notes_provider, 'antigravity')
            self.assertEqual(options.antigravity_model, model)

    @patch('src.notes_generator.shutil.which', return_value='/bin/agy')
    @patch('src.notes_generator.subprocess.run')
    def test_large_prompt_and_visuals_reach_isolated_run_and_are_cleaned(self, run, _which):
        prompt = 'lecture text\n' * 20000
        directories = []
        def invoke(command, **kwargs):
            directory = Path(kwargs['cwd'])
            directories.append(directory)
            self.assertEqual((directory / 'visual-1.png').read_bytes(), b'visual')
            message = json.loads(kwargs['input'])
            self.assertEqual(message['event'], 'user')
            self.assertTrue(message['message']['content'].startswith(prompt))
            self.assertIn('visual-1.png', message['message']['content'])
            self.assertNotIn(prompt, command)
            self.assertIn('--sandbox', command)
            self.assertNotIn('--dangerously-skip-permissions', command)
            self.assertEqual(command[-2:], ['--model', 'selected-model'])
            self.assertEqual(kwargs['timeout'], 60)
            return completed()
        run.side_effect = invoke
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / 'slide.png'
            image.write_bytes(b'visual')
            self.assertEqual(_run_antigravity(prompt, 'agy', 'selected-model', 60, [image]), '# Notes')
        self.assertFalse(directories[0].exists())

    @patch('src.notes_generator.shutil.which', return_value='/bin/agy')
    @patch('src.notes_generator.subprocess.run', return_value=completed())
    def test_blank_model_uses_cli_default(self, run, _which):
        self.assertEqual(_run_antigravity('lecture', 'agy', '', 60, []), '# Notes')
        self.assertNotIn('--model', run.call_args.args[0])

    @patch('src.notes_generator.shutil.which', return_value='/bin/agy')
    @patch('src.notes_generator.subprocess.run')
    def test_incomplete_failed_or_malformed_results_never_become_notes(self, run, _which):
        for result in [completed(''), completed('partial', 'ERROR'),
                       subprocess.CompletedProcess([], 0, 'not json', ''),
                       subprocess.CompletedProcess([], 0, '{"event":"init"}\n', ''),
                       subprocess.CompletedProcess([], 1, '', 'authentication required'),
                       subprocess.CompletedProcess([], 2, '', 'flag provided but not defined: -input-format')]:
            with self.subTest(result=result):
                run.return_value = result
                with self.assertRaises(RuntimeError):
                    _run_antigravity('lecture', 'agy', '', 60, [])

    @patch('src.notes_generator.shutil.which', return_value='/bin/agy')
    @patch('src.notes_generator.subprocess.run', side_effect=subprocess.TimeoutExpired('agy', 60))
    def test_timeout_reports_provider(self, _run, _which):
        with self.assertRaisesRegex(RuntimeError, 'Antigravity.*timed out'):
            _run_antigravity('lecture', 'agy', '', 60, [])

    @patch('src.notes_generator.shutil.which', return_value=None)
    def test_missing_cli_explains_sign_in(self, _which):
        with self.assertRaisesRegex(RuntimeError, 'run `agy` once'):
            _run_antigravity('lecture', 'agy', '', 60, [])

    @patch('src.notes_generator._run_antigravity', return_value='# Notes')
    @patch('src.notes_generator._run_codex')
    def test_notes_generation_routes_to_antigravity(self, codex, agy):
        with tempfile.TemporaryDirectory() as directory:
            notes = generate_notes_markdown(
                lecture_id='lecture', source_url='',
                transcript=TranscriptResult('en', 'Lecture text', []),
                page_contexts=[], matches=[], notes_assets_dir=Path(directory),
                notes_provider='antigravity', antigravity_model='selected',
            )
            self.assertIn('# Notes', notes)
            self.assertEqual(agy.call_args.args[2], 'selected')
            codex.assert_not_called()

    def test_api_writes_antigravity_metadata(self):
        from src.api import ProcessOptions, process_media
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / 'lecture.mp4'
            media.write_bytes(b'media')
            with patch('src.api.transcribe_media', return_value=TranscriptResult('en', 'lecture', [])), \
                 patch('src.api.generate_notes_markdown', return_value='# Note') as generate:
                artifacts = process_media(media, ProcessOptions(
                    workspace_root=root / 'work', output_root=root / 'out',
                    notes_mode='api', notes_provider='antigravity',
                    antigravity_model='selected',
                ))
            self.assertEqual(generate.call_args.kwargs['antigravity_model'], 'selected')
            metadata = json.loads(artifacts.metadata_json.read_text())
            self.assertEqual(metadata['notes_generator'], {
                'provider': 'antigravity-cli', 'model': 'selected', 'reasoning_effort': None,
            })
