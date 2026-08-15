import json, sys, os
BASE = os.path.join(os.path.dirname(__file__), '..', '..', 'tray/webext/_locales')
en = json.load(open(os.path.join(BASE, 'en/messages.json')))
def emit(loc, m):
    want = [k for k in en if k != 'appName']
    miss = [k for k in want if k not in m]
    extra = [k for k in m if k not in en]
    if miss or extra:
        sys.exit(f'{loc}: missing {miss} extra {extra}')
    out = {k: {'message': m[k]} for k in want}
    d = os.path.join(BASE, loc); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'messages.json'), 'w') as f:
        json.dump(out, f, ensure_ascii=False, indent=2); f.write('\n')
    print(f'{loc}: {len(out)} keys')
