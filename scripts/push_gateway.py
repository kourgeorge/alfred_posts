"""Push source using a short-lived Sites credential without writing it to disk."""
import getpass
import os
import subprocess
import sys
from urllib.parse import urlparse

remote, branch = sys.argv[1:]
if urlparse(remote).scheme != 'https' or urlparse(remote).username:
    raise SystemExit('Expected a credential-free HTTPS source URL.')
token = getpass.getpass('Sites source token (hidden): ')
environment = os.environ.copy()
environment.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='http.extraHeader',
                   GIT_CONFIG_VALUE_0=f'Authorization: Bearer {token}', GIT_TERMINAL_PROMPT='0')
result = subprocess.run(['git', 'push', remote, f'HEAD:refs/heads/{branch}'], env=environment)
raise SystemExit(result.returncode)
