import json
import os
import sys


def read_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def write_json(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def main():
    # Prefer CLI args if provided (may not be when launched via gnubg -p),
    # otherwise fall back to environment variables set by the Node runner.
    input_path = None
    output_path = None
    if len(sys.argv) >= 3:
        input_path = sys.argv[1]
        output_path = sys.argv[2]
    else:
        input_path = os.environ.get('GNUBG_INPUT_JSON')
        output_path = os.environ.get('GNUBG_OUTPUT_JSON')

    if not input_path or not output_path:
        print('Usage: analyze_position.py <input_json> <output_json> (or set GNUBG_INPUT_JSON and GNUBG_OUTPUT_JSON)')
        # best-effort: write an error json if possible
        try:
            if output_path:
                write_json(output_path, {
                    'matchId': None,
                    'positionIndex': None,
                    'engineAvailable': False,
                    'moves': [],
                    'error': 'Input/output paths not provided'
                })
        finally:
            sys.exit(1)

    try:
        params = read_json(input_path)
    except Exception as e:
        out = {
            'matchId': None,
            'positionIndex': None,
            'engineAvailable': False,
            'moves': [],
            'error': f'Failed to read input: {e}'
        }
        write_json(output_path, out)
        return

    match_id = params.get('matchId')
    position_index = params.get('positionIndex')

    # Try import gnubg python module if available under gnubg -p
    engine_available = False
    try:
        # When run via gnubg -p, the embedded python environment provides a 'gnubg' module
        import gnubg  # type: ignore
        engine_available = True

        # Initialize analysis engine and basic settings
        init_cmds = [
            'set engine on',
            'set analysis chequerplay on',
            'set analysis cubedecision on',
            'set threads 2',
            'set player 0 chequerplay normal',
            'set player 1 chequerplay normal'
        ]
        for cmd in init_cmds:
            try:
                gnubg.command(cmd)
            except Exception:
                pass

        # If a GNUbg ID was provided (posID:matchID), set the position
        if isinstance(match_id, str) and ':' in match_id:
            try:
                gnubg.command(f'set position id {match_id}')
            except Exception:
                # ignore if not supported; this is a best-effort init
                pass

        # Optionally trigger a quick evaluation to warm up engine
        try:
            gnubg.command('hint')
        except Exception:
            pass

    except Exception:
        engine_available = False

    # NOTE: This is a stub implementation. The real implementation should:
    # 1) Load the match and reconstruct the board at position_index
    # 2) Ask gnubg for best moves and equities
    # For now, we return a fixed example so the Node endpoint works end-to-end.

    example_moves = [
        { 'move': '24/18 13/9', 'equity': -0.1234 },
        { 'move': '24/20 13/9', 'equity': -0.1456 },
        { 'move': '13/7 6/2', 'equity': -0.1678 }
    ]

    out = {
        'matchId': match_id,
        'positionIndex': position_index,
        'engineAvailable': engine_available,
        'moves': example_moves
    }

    write_json(output_path, out)


if __name__ == '__main__':
    main()


