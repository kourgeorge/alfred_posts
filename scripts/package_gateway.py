"""Package only the server entrypoint and hosting metadata; never local secrets."""
import subprocess
import tarfile
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
target = root / 'gateway-dist.tar.gz'
with tempfile.TemporaryDirectory() as directory:
    build = Path(directory)
    (build / '.openai').mkdir()
    (build / '.openai/hosting.json').write_text((root / '.openai/hosting.json').read_text())
    # Bundle gateway/worker.js with its shared core.js into the single entrypoint Sites runs.
    subprocess.run(['npx', 'esbuild', str(root / 'gateway/worker.js'), '--bundle', '--format=esm',
                    '--platform=neutral', f'--outfile={build / "index.js"}', '--log-level=warning'],
                   cwd=root, check=True)
    with tarfile.open(target, 'w:gz') as archive:
        for path in sorted(build.rglob('*')):
            if path.is_file():
                archive.add(path, arcname=str(path.relative_to(build)))
print(target)
