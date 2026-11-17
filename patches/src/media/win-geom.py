#!/usr/bin/env python3
# 列出 XWayland 窗口的几何：面板里的窗口项靠尺寸和 portal 回来的流对号入座
import json
try:
    from Xlib import display, X
except Exception:
    print('[]')
    raise SystemExit(0)

try:
    d = display.Display()
    root = d.screen().root
    prop = root.get_full_property(d.intern_atom('_NET_CLIENT_LIST'), X.AnyPropertyType)
    out = []
    if prop:
        for wid in prop.value:
            try:
                w = d.create_resource_object('window', wid)
                if w.get_attributes().map_state != X.IsViewable:
                    continue
                g = w.get_geometry()
                tr = w.translate_coords(root, 0, 0)
                name = ''
                for atom in ('_NET_WM_NAME', 'WM_NAME'):
                    pr = w.get_full_property(d.intern_atom(atom), X.AnyPropertyType)
                    if pr and pr.value:
                        v = pr.value
                        name = v.decode('utf-8', 'ignore') if isinstance(v, (bytes, bytearray)) else str(v)
                        break
                out.append({'id': int(wid), 'name': name,
                            'x': int(-tr.x), 'y': int(-tr.y),
                            'w': int(g.width), 'h': int(g.height)})
            except Exception:
                continue
    print(json.dumps(out, ensure_ascii=False))
except Exception:
    print('[]')
