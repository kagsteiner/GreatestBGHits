import json
import os
import re
import sys


def read_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def write_json(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def log(msg):
    try:
        print(msg)
        sys.stdout.flush()
    except Exception:
        pass


def preview(text, max_lines=8):
    lines = (text or '').splitlines()
    if len(lines) > max_lines:
        lines = lines[:max_lines] + ['... (truncated)']
    return '\n'.join(lines)


def join_move_parts(parts):
    tokens = []
    for p in parts:
        try:
            from_pt = p.get('from')
            to_pt = p.get('to')
            hit = p.get('hit')
            if from_pt is None or to_pt is None:
                continue
            token = f"{from_pt}/{to_pt}{'*' if hit else ''}"
            tokens.append(token)
        except Exception:
            # ignore malformed parts
            continue
    return ' '.join(tokens)


def parse_hint_output_to_candidates(hint_text, max_candidates=8):
    candidates = []
    # Try to match lines like:
    #  1. 13/7 8/7           +0.123
    #  1) 13/7 8/7           +0.123
    # or variants that show equity first
    line_pattern = re.compile(r"^\s*(\d+)[\.)]\s+([^\s].*?)\s+([+-]?\d+\.\d+)")

    for line in hint_text.splitlines():
        m = line_pattern.search(line)
        if not m:
            continue
        rank = int(m.group(1))
        move = m.group(2).strip()
        try:
            equity = float(m.group(3))
        except Exception:
            continue
        candidates.append({ 'rank': rank, 'move': move, 'equity': equity })
        if len(candidates) >= max_candidates:
            break

    # Fallback: GNUBG sometimes puts equity before move
    if not candidates:
        alt_pattern = re.compile(r"^\s*(\d+)[\.)]\s+Equity\s*[:=]\s*([+-]?\d+\.\d+)\s+([^\s].*)")
        for line in hint_text.splitlines():
            m = alt_pattern.search(line)
            if not m:
                continue
            rank = int(m.group(1))
            equity = float(m.group(2))
            move = m.group(3).strip()
            candidates.append({ 'rank': rank, 'move': move, 'equity': equity })
            if len(candidates) >= max_candidates:
                break

    # Sort by rank just in case
    candidates.sort(key=lambda c: c.get('rank', 9999))
    return candidates


def normalize_move_text(move_text):
    # GNUBG may collapse spaces; normalize for comparison
    return ' '.join(move_text.strip().split())


def move_to_token_multiset(move_text):
    """Convert move string like '13/7 8/7' into a sorted tuple of tokens
    to allow order-insensitive comparison (e.g., '8/7 13/7' same as '13/7 8/7').
    Preserves duplicates by not de-duplicating tokens.
    """
    if not move_text:
        return tuple()
    tokens = [t for t in move_text.strip().split() if t]
    # Sort tokens lexicographically for a stable order
    tokens.sort()
    return tuple(tokens)


def convert_token_for_gnubg(token):
    """Convert a single move token to GNUBG CLI notation.
    - 25/x -> bar/x
    - x/0 -> x/off
    Keeps trailing '*' for hits.
    """
    if not token:
        return token
    hit = ''
    if token.endswith('*'):
        hit = '*'
        token = token[:-1]
    if '/' not in token:
        return token + hit
    from_pt, to_pt = token.split('/', 1)
    if from_pt == '25':
        from_pt = 'bar'
    if to_pt == '0':
        to_pt = 'off'
    return f"{from_pt}/{to_pt}{hit}"


def convert_move_for_gnubg(move_text):
    """Convert a full move string (space-separated tokens) to GNUBG CLI notation."""
    tokens = [t for t in (move_text or '').split(' ') if t]
    converted = [convert_token_for_gnubg(t) for t in tokens]
    return ' '.join(converted)


def main():
    input_path = None
    output_path = None
    if len(sys.argv) >= 3:
        input_path = sys.argv[1]
        output_path = sys.argv[2]
    else:
        input_path = os.environ.get('GNUBG_INPUT_JSON')
        output_path = os.environ.get('GNUBG_OUTPUT_JSON')

    if not input_path or not output_path:
        print('Usage: analyze_match.py <input_json> <output_json> (or set GNUBG_INPUT_JSON and GNUBG_OUTPUT_JSON)')
        try:
            if output_path:
                write_json(output_path, { 'mistakes': [], 'error': 'Input/output paths not provided' })
        finally:
            sys.exit(1)

    try:
        params = read_json(input_path)
    except Exception as e:
        write_json(output_path, { 'mistakes': [], 'error': f'Failed to read input: {e}' })
        return

    match = params.get('match')
    # Threshold must be passed from Node side; do not define a local default here
    # to centralize the default in src/constants.js
    threshold = params.get('threshold', 0.0)
    max_candidates = params.get('maxCandidates', 8)

    mistakes = []
    engine_available = False

    try:
        import gnubg  # type: ignore
        engine_available = True
        log('Analyzer: GNUBG python engine loaded')

        # Initialize engine settings (conservative to avoid unknown keyword errors)
        setup_cmds = [
            'set threads 2',
            'set output raw on',
            'set player 0 human',
            'set player 1 human'
        ]
        for cmd in setup_cmds:
            try:
                gnubg.command(cmd)
            except Exception as e:
                log(f'Analyzer: setup command failed: {cmd} -> {e}')

        # Accept either a full match (with games array) or a single game object (with moves array)
        games = []
        if isinstance(match, dict):
            if 'games' in match and isinstance(match['games'], list):
                games = match['games']
            elif 'moves' in match and isinstance(match['moves'], list):
                games = [match]
        log(f'Analyzer: starting analysis; games={len(games)} threshold={threshold}')
        for game in games:
            try:
                gnubg.command('new game')
                log(f"Analyzer: Game {game.get('gameNumber')} new game")
            except Exception as e:
                log(f"Analyzer: 'new game' failed -> {e}")

            moves = game.get('moves', [])
            log(f"Analyzer: Game {game.get('gameNumber')} moves={len(moves)}")
            for move_record in moves:
                # Player 1 turn
                p1 = move_record.get('player1')
                if p1 and p1.get('type') in ('move', 'double', 'take', 'drop'):
                    if p1.get('type') == 'move' and p1.get('dice'):
                        d1 = p1['dice'].get('die1')
                        d2 = p1['dice'].get('die2')
                        try:
                            gnubg.command(f'set dice {d1} {d2}')
                        except Exception as e:
                            log(f"Analyzer: set dice failed (G{game.get('gameNumber')} M{move_record.get('moveNumber')} P1) -> {e}")

                        # Ensure GNUBG is in analysis-only mode: roll explicitly using our dice
                        try:
                            gnubg.command('roll')
                        except Exception as e:
                            log(f"Analyzer: roll failed (P1) -> {e}")

                        # Evaluate position
                        hint_text = ''
                        try:
                            hint_text = gnubg.command('hint') or ''
                        except Exception as e:
                            log(f"Analyzer: hint failed (G{game.get('gameNumber')} M{move_record.get('moveNumber')} P1) -> {e}")
                            hint_text = ''

                        candidates = parse_hint_output_to_candidates(hint_text, max_candidates)
                        log(f"Analyzer: candidates (P1) count={len(candidates)}")
                        if not candidates:
                            log(f"Analyzer: no candidates parsed (P1); hint preview:\n{preview(hint_text)}")

                        player_move_text = join_move_parts(p1.get('moves', []))
                        player_move_cli = convert_move_for_gnubg(player_move_text)
                        log(f"Analyzer: P1 move raw='{player_move_text}' cli='{player_move_cli}'")
                        player_move_norm = normalize_move_text(player_move_cli)
                        player_tokens = move_to_token_multiset(player_move_norm)

                        best_equity = None
                        player_equity = None

                        if candidates:
                            best_equity = candidates[0]['equity']
                            # try to find player's move among candidates (normalize spacing and order)
                            for c in candidates:
                                cand_tokens = move_to_token_multiset(normalize_move_text(c['move']))
                                if cand_tokens == player_tokens:
                                    player_equity = c['equity']
                                    break
                        if best_equity is not None and player_equity is None:
                            log(f"Analyzer: player's move not among candidates (P1) -> '{player_move_text}'")

                        # If not found, just skip diff computation for this ply
                        if best_equity is not None and player_equity is not None:
                            diff = best_equity - player_equity
                            if diff >= float(threshold):
                                pos_id = ''
                                try:
                                    pos_id = (gnubg.command('board id') or '').strip()
                                except Exception:
                                    pos_id = ''

                                mistakes.append({
                                    'gameNumber': game.get('gameNumber'),
                                    'plyIndex': move_record.get('moveNumber'),
                                    'player': 'player1',
                                    'dice': p1.get('dice'),
                                    'playerMove': player_move_text,
                                    'candidates': candidates,
                                    'bestEquity': best_equity,
                                    'playerEquity': player_equity,
                                    'equityDiff': diff,
                                    'positionId': pos_id
                                })
                                log(f"Analyzer: mistake recorded (P1) G{game.get('gameNumber')} M{move_record.get('moveNumber')} diff={diff:.3f}")

                        # Play the actual move to advance the board
                        if player_move_cli:
                            try:
                                gnubg.command(f'move {player_move_cli}')
                            except Exception as e:
                                log(f"Analyzer: move apply failed (P1) '{player_move_cli}' -> {e}")
                    elif p1.get('type') == 'double':
                        try:
                            gnubg.command('double')
                            log('Analyzer: double (P1)')
                        except Exception as e:
                            log(f'Analyzer: double failed (P1) -> {e}')
                    elif p1.get('type') == 'take':
                        try:
                            gnubg.command('take')
                            log('Analyzer: take (P2)')
                        except Exception as e:
                            log(f'Analyzer: take failed (P2) -> {e}')
                    elif p1.get('type') == 'drop':
                        try:
                            gnubg.command('drop')
                            log('Analyzer: drop (P2)')
                        except Exception as e:
                            log(f'Analyzer: drop failed (P2) -> {e}')

                # Player 2 turn
                p2 = move_record.get('player2')
                if p2 and p2.get('type') in ('move', 'double', 'take', 'drop'):
                    if p2.get('type') == 'move' and p2.get('dice'):
                        d1 = p2['dice'].get('die1')
                        d2 = p2['dice'].get('die2')
                        try:
                            gnubg.command(f'set dice {d1} {d2}')
                        except Exception as e:
                            log(f"Analyzer: set dice failed (G{game.get('gameNumber')} M{move_record.get('moveNumber')} P2) -> {e}")

                        try:
                            gnubg.command('roll')
                        except Exception as e:
                            log(f"Analyzer: roll failed (P2) -> {e}")

                        hint_text = ''
                        try:
                            hint_text = gnubg.command('hint') or ''
                        except Exception as e:
                            log(f"Analyzer: hint failed (G{game.get('gameNumber')} M{move_record.get('moveNumber')} P2) -> {e}")
                            hint_text = ''

                        candidates = parse_hint_output_to_candidates(hint_text, max_candidates)
                        if not candidates:
                            log(f"Analyzer: no candidates parsed (P2); hint preview:\n{preview(hint_text)}")

                        player_move_text = join_move_parts(p2.get('moves', []))
                        player_move_cli = convert_move_for_gnubg(player_move_text)
                        log(f"Analyzer: P2 move raw='{player_move_text}' cli='{player_move_cli}'")
                        player_move_norm = normalize_move_text(player_move_cli)
                        player_tokens = move_to_token_multiset(player_move_norm)

                        best_equity = None
                        player_equity = None
                        if candidates:
                            best_equity = candidates[0]['equity']
                            for c in candidates:
                                cand_tokens = move_to_token_multiset(normalize_move_text(c['move']))
                                if cand_tokens == player_tokens:
                                    player_equity = c['equity']
                                    break
                        if best_equity is not None and player_equity is None:
                            log(f"Analyzer: player's move not among candidates (P2) -> '{player_move_text}'")

                        if best_equity is not None and player_equity is not None:
                            diff = best_equity - player_equity
                            if diff >= float(threshold):
                                pos_id = ''
                                try:
                                    pos_id = (gnubg.command('board id') or '').strip()
                                except Exception:
                                    pos_id = ''

                                mistakes.append({
                                    'gameNumber': game.get('gameNumber'),
                                    'plyIndex': move_record.get('moveNumber'),
                                    'player': 'player2',
                                    'dice': p2.get('dice'),
                                    'playerMove': player_move_text,
                                    'candidates': candidates,
                                    'bestEquity': best_equity,
                                    'playerEquity': player_equity,
                                    'equityDiff': diff,
                                    'positionId': pos_id
                                })

                        if player_move_cli:
                            try:
                                gnubg.command(f'move {player_move_cli}')
                            except Exception as e:
                                log(f"Analyzer: move apply failed (P2) '{player_move_cli}' -> {e}")
                    elif p2.get('type') == 'double':
                        try:
                            gnubg.command('double')
                            log('Analyzer: double (P2)')
                        except Exception as e:
                            log(f'Analyzer: double failed (P2) -> {e}')
                    elif p2.get('type') == 'take':
                        try:
                            gnubg.command('take')
                            log('Analyzer: take (P1)')
                        except Exception as e:
                            log(f'Analyzer: take failed (P1) -> {e}')
                    elif p2.get('type') == 'drop':
                        try:
                            gnubg.command('drop')
                            log('Analyzer: drop (P1)')
                        except Exception as e:
                            log(f'Analyzer: drop failed (P1) -> {e}')

        # Sort by equity difference desc
        mistakes.sort(key=lambda m: m.get('equityDiff', 0), reverse=True)

        write_json(output_path, {
            'engineAvailable': engine_available,
            'threshold': threshold,
            'mistakes': mistakes
        })

    except Exception as e:
        log(f'Analyzer: fatal error -> {e}')
        write_json(output_path, {
            'engineAvailable': engine_available,
            'mistakes': [],
            'error': f'Engine error: {e}'
        })


if __name__ == '__main__':
    main()


