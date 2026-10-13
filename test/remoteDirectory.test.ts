import test from 'node:test';
import assert from 'node:assert/strict';
import { insideRemoteDirectory } from '../src/remoteDirectory.js';

test('remote directory containment handles POSIX and Windows paths independent of the server OS', () => {
  for (const [root, cwd] of [
    ['/repo', '/repo/'], ['/repo', '/repo/nested/project'], ['/', '/repo'],
    ['C:\\repo', 'c:\\repo\\nested'], ['C:\\repo', 'C:/repo/nested'],
    ['\\\\host\\share\\repo', '\\\\host\\share\\repo\\nested']
  ]) assert.equal(insideRemoteDirectory(root, cwd), true, `${root}: ${cwd}`);
  for (const [root, cwd] of [
    ['/repo', '/repo-sibling'], ['/repo', '/repo/../../etc'], ['/repo', 'repo/nested'],
    ['/repo', '/repo/\0invalid'], ['C:\\repo', 'C:\\repo\\..\\outside'],
    ['C:\\repo', 'D:\\repo'], ['C:\\repo', 'C:repo'], ['C:\\repo', 'C:\\repo-sibling'],
    ['\\\\host\\share\\repo', '\\\\other\\share\\repo']
  ]) assert.equal(insideRemoteDirectory(root, cwd), false, `${root}: ${cwd}`);
});
