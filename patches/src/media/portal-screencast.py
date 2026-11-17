#!/usr/bin/env python3
# 建立一个可持久化的 ScreenCast 会话：首次授权后把 restore_token 存下来，
# 以后同一 token 复用就不再弹窗，并把 PipeWire node id 交回 Node 侧。
import json
import os
import sys
import time

import dbus
import dbus.mainloop.glib
from gi.repository import GLib

TYPES = 3  # 1=显示器 2=窗口 3=两者
for arg in sys.argv[1:]:
    if arg.startswith('--types='):
        try:
            TYPES = int(arg.split('=', 1)[1])
        except Exception:
            pass

# 令牌位置由主进程给（Electron userData），自己跑时退回 ~/.config/KOOK
TOKEN_FILE = os.environ.get('KOOK_PORTAL_TOKEN') or os.path.expanduser(
    '~/.config/KOOK/portal-screencast-%d.json' % TYPES)


def load_token():
    try:
        with open(TOKEN_FILE, 'r', encoding='utf-8') as f:
            return (json.load(f) or {}).get('restore_token') or ''
    except Exception:
        return ''


def save_token(token):
    if not token:
        return
    try:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        with open(TOKEN_FILE, 'w', encoding='utf-8') as f:
            json.dump({'restore_token': str(token)}, f)
    except Exception:
        pass


dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
sender = bus.get_unique_name()[1:].replace('.', '_')
portal = dbus.Interface(
    bus.get_object('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop'),
    'org.freedesktop.portal.ScreenCast',
)

results = {}


def wait(token, timeout=120):
    path = f'/org/freedesktop/portal/desktop/request/{sender}/{token}'
    results.clear()

    def cb(response, res):
        results['r'] = (int(response), res)
        loop.quit()

    bus.add_signal_receiver(cb, signal_name='Response',
                            dbus_interface='org.freedesktop.portal.Request', path=path)
    end = time.time() + timeout
    while 'r' not in results and time.time() < end:
        GLib.MainContext.default().iteration(False)
        time.sleep(0.05)
    return results.get('r')


loop = GLib.MainLoop()

handle = portal.CreateSession({
    'handle_token': dbus.String('kook_t1'),
    'session_handle_token': dbus.String('kook_s1'),
})
res = wait('kook_t1', 30)
if not res or res[0] != 0:
    print(json.dumps({'ok': False, 'stage': 'create', 'response': res and res[0]}))
    sys.exit(1)

session = f'/org/freedesktop/portal/desktop/session/{sender}/kook_s1'
opts = {
    'handle_token': dbus.String('kook_t2'),
    'types': dbus.UInt32(TYPES),      # 1=显示器 | 2=窗口
    'multiple': dbus.Boolean(True),   # 允许一次选多个：屏幕 + 多个窗口
    'cursor_mode': dbus.UInt32(2),    # 嵌入式光标
    'persist_mode': dbus.UInt32(2),   # 持久授权：授权一次后不再询问
}
token = load_token()
if token:
    opts['restore_token'] = dbus.String(token)

portal.SelectSources(dbus.ObjectPath(session), opts)
res = wait('kook_t2', 120)
if not res or res[0] != 0:
    print(json.dumps({'ok': False, 'stage': 'select', 'response': res and res[0]}))
    sys.exit(2)

portal.Start(dbus.ObjectPath(session), dbus.String(''), {'handle_token': dbus.String('kook_t3')})
res = wait('kook_t3', 120)
if not res or res[0] != 0:
    print(json.dumps({'ok': False, 'stage': 'start', 'response': res and res[0]}))
    sys.exit(3)

data = res[1]
restore = ''
try:
    restore = str(data.get('restore_token', ''))
except Exception:
    pass
save_token(restore)

streams = data.get('streams') or []
items = []
for st in streams:
    try:
        node = int(st[0])
    except Exception:
        continue
    props = st[1] if len(st) > 1 else {}
    size = props.get('size') if hasattr(props, 'get') else None
    items.append({
        'node_id': node,
        'source_type': int(props.get('source_type', 0)) if hasattr(props, 'get') else 0,
        'width': int(size[0]) if size else 0,
        'height': int(size[1]) if size else 0,
    })

print(json.dumps({'ok': bool(items), 'types': TYPES, 'streams': items,
                  'node_id': items[0]['node_id'] if items else None,
                  'restore_token': restore, 'session': session}), flush=True)

# 保持会话存活：Node 侧还要用这个 node 抓帧
try:
    while True:
        GLib.MainContext.default().iteration(False)
        time.sleep(0.2)
except KeyboardInterrupt:
    pass
