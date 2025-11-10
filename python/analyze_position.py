import json
import os
import re
import sys


def read_json(path):
    with open(path, 'r', encoding='utf-8-sig') as f:
        return json.load(f)


def write_json(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def parse_hint_output_to_candidates(hint_text, max_candidates=8):
    candidates = []
    # Typical formats:
    #  1. 13/7 8/7           +0.123
    #  1) 13/7 8/7           +0.123
    # or variants with Equity shown first
    # allow optional parentheses around equity and trailing annotations
    line_pattern = re.compile(r"^\s*(\d+)[\.)]\s+([^\s].*?)\s+\(?\s*([+-]?\d+\.\d+)\s*\)?")

    for line in hint_text.splitlines():
        m = line_pattern.search(line)
        if not m:
            continue
        try:
            rank = int(m.group(1))
            move = m.group(2).strip()
            equity = float(m.group(3))
        except Exception:
            continue
        candidates.append({'rank': rank, 'move': move, 'equity': equity})
        if len(candidates) >= max_candidates:
            break

    if not candidates:
        alt_pattern = re.compile(r"^\s*(\d+)[\.)]\s+Equity\s*[:=]\s*([+-]?\d+\.\d+)\s+([^\s].*)")
        for line in hint_text.splitlines():
            m = alt_pattern.search(line)
            if not m:
                continue
            try:
                rank = int(m.group(1))
                equity = float(m.group(2))
                move = m.group(3).strip()
            except Exception:
                continue
            candidates.append({'rank': rank, 'move': move, 'equity': equity})
            if len(candidates) >= max_candidates:
                break

    candidates.sort(key=lambda c: c.get('rank', 9999))
    return candidates


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
    dice = params.get('dice')  # optional: { die1: number, die2: number }

    # Try import gnubg python module if available under gnubg -p
    engine_available = False
    moves = []
    try:
        # When run via gnubg -p, the embedded python environment provides a 'gnubg' module
        import gnubg  # type: ignore
        engine_available = True

        # Initialize conservative settings
        init_cmds = [
            'set output raw on',
            # Ensure GNUBG generates dice automatically instead of prompting on stdin
            'set rng mersenne',
            'set dice manual off',
            'set automatic roll on',
            'set threads 2',
            'set player 0 human',
            'set player 1 human'
        ]
        for cmd in init_cmds:
            try:
                gnubg.command(cmd)
            except Exception:
                pass

        # Ensure a game context exists
        try:
            gnubg.command('new game')
        except Exception:
            pass

        # If a GNUbg ID was provided (posID:matchID), split and set each
        if isinstance(match_id, str) and ':' in match_id:
            pos_id, match_only = match_id.split(':', 1)
            try:
                gnubg.command(f'set matchid {match_only}')
            except Exception:
                pass
            try:
                gnubg.command(f'set board {pos_id}')
            except Exception:
                pass

        # Read back current board id for diagnostics
        current_id = None
        try:
            current_id = (gnubg.command('show gnubgid') or '').strip()
        except Exception:
            try:
                current_id = (gnubg.command('show matchid') or '').strip()
            except Exception:
                current_id = None

        # Capture ASCII board for diagnostics
        board_text = None
        try:
            board_text = gnubg.command('show board') or ''
        except Exception:
            board_text = None


        # Ensure dice are set for checker play hint. If not provided, roll.
        try:
            if isinstance(dice, dict) and 'die1' in dice and 'die2' in dice:
                d1 = int(dice.get('die1'))
                d2 = int(dice.get('die2'))
                gnubg.command(f'set dice {d1} {d2}')
            else:
                try:
                    gnubg.command('roll')
                except Exception:
                    # Fallback if manual dice or roll not available: set a valid dice
                    gnubg.command('set dice 1 1')
        except Exception:
            # proceed anyway; hint may still return something in some builds
            pass

        # Request move hints for the current position
        hint_text = ''
        try:
            hint_text = gnubg.command('hint') or ''
        except Exception:
            hint_text = ''

        candidates = parse_hint_output_to_candidates(hint_text, max_candidates=8)
        # Map to required shape
        moves = [{ 'move': c['move'], 'equity': c['equity'] } for c in candidates]

    except Exception:
        engine_available = False
        moves = []

    out = {
        'matchId': match_id,
        'positionIndex': position_index,
        'engineAvailable': engine_available,
        'moves': moves,
        'rawHint': hint_text if isinstance(hint_text, str) else None,
        'currentBoardId': current_id if 'current_id' in locals() else None,
        'boardAscii': board_text if 'board_text' in locals() else None
    }

    write_json(output_path, out)


if __name__ == '__main__':
    main()


