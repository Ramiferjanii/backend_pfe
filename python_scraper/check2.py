import json
with open('venv_out.txt', 'r', encoding='utf-8') as f:
    data = json.loads(f.read())
items = data.get('data', {}).get('data', [])
print('Items found:', len(items))
if items:
    print('First item:', items[0]['name'][:60])
    print('Last item:', items[-1]['name'][:60])
else:
    print('ERROR: No items returned!')
    print('Response keys:', list(data.keys()))
    print('data.data:', data.get('data', {}))
