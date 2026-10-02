"""Package only the server entrypoint and hosting metadata; never local secrets."""
import tarfile
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
target = root / 'gateway-dist.tar.gz'
with tempfile.TemporaryDirectory() as directory:
    build = Path(directory)
    (build / '.openai').mkdir()
    (build / '.openai/hosting.json').write_text((root / '.openai/hosting.json').read_text())
    (build / 'index.js').write_text((root / 'gateway/worker.js').read_text())
    with tarfile.open(target, 'w:gz') as archive:
        for path in sorted(build.rglob('*')):
            if path.is_file():
                archive.add(path, arcname=str(path.relative_to(build)))
print(target)
