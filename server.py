import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
MAX_TRACE_STEPS = 2000
TRACE_JSON_PREFIX = "__CODEX_JSON__"


@dataclass
class TraceError(Exception):
    message: str
    details: str = ""
    status: int = HTTPStatus.BAD_REQUEST


class CppTracer:
    def __init__(self) -> None:
        compiler = shutil.which("clang++") or shutil.which("g++")
        if not compiler:
            raise TraceError("No C++ compiler found.", status=HTTPStatus.INTERNAL_SERVER_ERROR)
        if not shutil.which("lldb"):
            raise TraceError("LLDB is not installed.", status=HTTPStatus.INTERNAL_SERVER_ERROR)
        self.compiler = compiler

    def trace(self, code: str) -> dict[str, Any]:
        if not code.strip():
            raise TraceError("Paste some C++ code first.")

        with tempfile.TemporaryDirectory(prefix="cpp-flow-") as temp_dir:
            workspace = Path(temp_dir)
            source_path = workspace / "program.cpp"
            binary_path = workspace / "program"
            source_path.write_text(code, encoding="utf-8")

            self._compile(source_path, binary_path)
            raw_output = self._run_lldb(binary_path, source_path, code)
            steps = self._parse_steps(raw_output, code, source_path.name)
            if not steps:
                raise TraceError(
                    "The program compiled, but no executable source-line trace was captured.",
                    details="Try code with a `main()` function and executable statements."
                )

            self._attach_flow_nodes(steps)
            steps = dedupe_consecutive_steps(steps)
            self._carry_forward_containers(steps)
            self._carry_forward_variables(steps)
            self._mark_changed_values(steps)

            final_stdout = steps[-1].get("stdout", "") if steps else ""

            return {
                "title": "Real LLDB trace",
                "code": code,
                "stdout": final_stdout,
                "steps": steps
            }

    def _compile(self, source_path: Path, binary_path: Path) -> None:
        result = subprocess.run(
            [
                self.compiler,
                "-std=c++17",
                "-O0",
                "-g",
                "-fno-inline",
                str(source_path),
                "-o",
                str(binary_path)
            ],
            capture_output=True,
            text=True,
            cwd=ROOT,
            timeout=30
        )
        if result.returncode != 0:
            raise TraceError("Compilation failed.", details=(result.stderr or result.stdout).strip())

    def _run_lldb(self, binary_path: Path, source_path: Path, code: str) -> str:
        commands_path = binary_path.with_suffix(".lldb")
        helper_path = binary_path.with_suffix(".py")
        stdout_path = binary_path.with_suffix(".out")
        stdout_path.write_text("", encoding="utf-8")
        helper_path.write_text(self._build_lldb_helper(), encoding="utf-8")
        commands_path.write_text(
            self._build_lldb_script(source_path, code, helper_path, stdout_path),
            encoding="utf-8"
        )

        try:
            result = subprocess.run(
                ["lldb", "-b", "-s", str(commands_path), "--", str(binary_path)],
                capture_output=True,
                text=True,
                cwd=ROOT,
                timeout=45
            )
        except subprocess.TimeoutExpired as exc:
            raise TraceError("Tracing timed out.", details="The debugger did not finish within 45 seconds.") from exc

        return (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")

    def _build_lldb_script(self, source_path: Path, code: str, helper_path: Path, stdout_path: Path) -> str:
        lines = code.splitlines()
        commands = [
            f"command script import {helper_path}",
            "settings set target.max-children-count 32",
            "settings set target.inline-breakpoint-strategy always",
        ]

        for line_number, line in enumerate(lines, start=1):
            stripped = line.strip()
            commands.append(f"breakpoint set --file {source_path.name} --line {line_number}")

        commands.append(f"process launch -o {stdout_path} -e /dev/null")

        for _ in range(MAX_TRACE_STEPS):
            commands.append(f"codex-step {source_path.name} {stdout_path}")
            commands.append("continue")

        return "\n".join(commands) + "\n"

    def _build_lldb_helper(self) -> str:
        return f"""
import json
import lldb

TRACE_PREFIX = {TRACE_JSON_PREFIX!r}

def __lldb_init_module(debugger, internal_dict):
    debugger.HandleCommand('command script add -f ' + __name__ + '.emit_step codex-step')

def emit_step(debugger, command, result, internal_dict):
    parts = command.strip().split(None, 1)
    source_name = parts[0]
    stdout_path = parts[1] if len(parts) > 1 else None

    target = debugger.GetSelectedTarget()
    process = target.GetProcess()
    thread = process.GetSelectedThread()

    if not process.IsValid() or not thread.IsValid():
        result.Print(TRACE_PREFIX + json.dumps({{'invalid': True}}))
        return

    current_frame = thread.GetFrameAtIndex(0)
    current_line_entry = current_frame.GetLineEntry()
    current_file = current_line_entry.GetFileSpec().GetFilename() if current_line_entry.IsValid() else ''
    current_line = current_line_entry.GetLine() if current_line_entry.IsValid() else 0

    stdout_so_far = ''
    if stdout_path:
        try:
            with open(stdout_path, 'r', errors='replace') as f:
                stdout_so_far = f.read()
        except Exception:
            pass

    payload = {{
        'file': current_file,
        'line': current_line,
        'stdout': stdout_so_far,
        'frames': []
    }}

    interpreter = debugger.GetCommandInterpreter()
    select_result = lldb.SBCommandReturnObject()
    vars_result = lldb.SBCommandReturnObject()

    for index in range(thread.GetNumFrames()):
        frame = thread.GetFrameAtIndex(index)
        line_entry = frame.GetLineEntry()
        if not line_entry.IsValid():
            continue
        file_spec = line_entry.GetFileSpec()
        if file_spec.GetFilename() != source_name:
            continue

        function_name = frame.GetFunctionName() or frame.GetDisplayFunctionName() or frame.GetName() or '<anonymous>'
        select_result.Clear()
        vars_result.Clear()
        vars_recursive = lldb.SBCommandReturnObject()
        vars_recursive.Clear()
        interpreter.HandleCommand(f'frame select {{index}}', select_result)
        interpreter.HandleCommand('frame variable', vars_result)
        interpreter.HandleCommand('frame variable -R', vars_recursive)

        arg_vars = frame.GetVariables(True, False, False, False)
        args_list = []
        for i in range(arg_vars.GetSize()):
            v = arg_vars.GetValueAtIndex(i)
            args_list.append(f'{{v.GetName()}} = {{v.GetValue() or v.GetSummary() or "?"}}')

        payload['frames'].append({{
            'index': index,
            'function': function_name,
            'line': line_entry.GetLine(),
            'vars_raw': vars_result.GetOutput() or '',
            'vars_recursive': vars_recursive.GetOutput() or '',
            'args': args_list
        }})

    interpreter.HandleCommand('frame select 0', select_result)
    result.Print(TRACE_PREFIX + json.dumps(payload))
"""

    def _parse_steps(self, raw_output: str, code: str, source_name: str) -> list[dict[str, Any]]:
        declaration_lines = find_declaration_lines(code)
        code_lines = code.splitlines()
        steps: list[dict[str, Any]] = []

        for line in raw_output.splitlines():
            if TRACE_JSON_PREFIX not in line:
                continue
            payload = json.loads(line.split(TRACE_JSON_PREFIX, 1)[1].strip())
            if payload.get("invalid") or payload.get("file") != source_name:
                continue

            current_line = int(payload["line"])
            raw_frames = payload.get("frames", [])
            stack_frames = self._parse_stack_frames(raw_frames)
            if not stack_frames:
                continue

            variables_by_depth: dict[int, list[dict[str, Any]]] = {}
            containers_by_depth: dict[int, dict[str, list[dict[str, Any]]]] = {}
            memory_by_depth: dict[int, dict[str, list[dict[str, str]]]] = {}

            for depth, raw_frame in enumerate(raw_frames):
                variables, containers, memory = parse_frame_variables(
                    raw_frame.get("vars_raw", ""),
                    raw_frame.get("line", current_line),
                    declaration_lines,
                    raw_frame.get("vars_recursive", ""),
                )
                stack_frames[depth]["locals"] = variables
                stack_frames[depth]["containers"] = containers
                stack_frames[depth]["memory"] = memory

                variables_by_depth[depth] = variables
                containers_by_depth[depth] = containers
                memory_by_depth[depth] = memory

            for depth, frame in enumerate(stack_frames):
                frame["status"] = "active" if depth == 0 else "waiting"
                frame["active"] = depth == 0

            merged_memory = merge_memory_graphs(memory_by_depth)
            line_text = code_lines[current_line - 1].strip() if current_line - 1 < len(code_lines) else ""
            function_name = stack_frames[0]["name"]
            event = describe_event(function_name, current_line, line_text)
            merged_containers = merge_containers(containers_by_depth)
            summary = describe_summary(function_name, line_text, len(stack_frames), merged_containers)
            top_frame = stack_frames[0]

            steps.append({
                "line": current_line,
                "event": event,
                "summary": summary,
                "stdout": payload.get("stdout", "").rstrip(),
                "stack": stack_frames,
                "containers": merged_containers,
                "activeContainers": top_frame.get("containers", empty_containers()),
                "memory": merged_memory
            })

        return steps

    def _parse_stack_frames(self, raw_frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
        frames = []
        for depth, raw_frame in enumerate(raw_frames):
            function = raw_frame.get("function", "<anonymous>")
            name, sig_args = split_function_signature(function)
            lldb_args = raw_frame.get("args") or []
            frames.append({
                "depth": depth,
                "name": name,
                "args": lldb_args if lldb_args else sig_args,
                "line": int(raw_frame.get("line", 0))
            })
        return frames

    def _mark_changed_values(self, steps: list[dict[str, Any]]) -> None:
        previous_values: dict[str, dict[str, Any]] = {}

        for step in steps:
            current_values: dict[str, dict[str, Any]] = {}
            for frame in step["stack"]:
                frame_values = previous_values.get(frame["id"], {})
                next_values: dict[str, Any] = {}
                for variable in frame["locals"]:
                    key = variable["name"]
                    variable["changed"] = frame_values.get(key) != variable["value"]
                    next_values[key] = variable["value"]
                current_values[frame["id"]] = next_values
            previous_values = current_values

    def _carry_forward_containers(self, steps: list[dict[str, Any]]) -> None:
        last_seen: dict[str, dict[str, list[dict[str, Any]]]] = {}
        kinds = ("arrays", "maps", "sets", "stacks", "queues", "priorityQueues", "lists", "graphs", "unknowns")

        for step in steps:
            current_seen: dict[str, dict[str, list[dict[str, Any]]]] = {}
            for frame in step["stack"]:
                frame_id = frame["id"]
                current = frame.get("containers", empty_containers())
                prev = last_seen.get(frame_id, empty_containers())

                merged = empty_containers()
                for kind in kinds:
                    cur_k = current.get(kind) or []
                    prev_k = prev.get(kind) or []
                    merged[kind] = (
                        merge_container_items_by_name(prev_k, cur_k)
                        if cur_k
                        else list(prev_k)
                    )

                frame["containers"] = merged
                current_seen[frame_id] = merged

            step["containers"] = merge_containers(
                {i: f["containers"] for i, f in enumerate(step["stack"])}
            )
            step["activeContainers"] = (
                step["stack"][0].get("containers", empty_containers())
                if step["stack"]
                else empty_containers()
            )

            last_seen = current_seen

    def _carry_forward_variables(self, steps: list[dict[str, Any]]) -> None:
        """Per-frame locals are keyed by frame id (function + stack slot). Active frame is LLDB-authoritative
        so block-scoped locals disappear when out of scope. Parent frames keep the last snapshot only when
        LLDB omits locals for non-active frames."""
        last_seen: dict[str, dict[str, Any]] = {}

        for step in steps:
            current_seen: dict[str, dict[str, Any]] = {}
            for frame in step["stack"]:
                frame_id = frame["id"]
                prev = last_seen.get(frame_id, {})
                current = {var["name"]: dict(var) for var in frame.get("locals", [])}

                if frame.get("active"):
                    merged = dict(current)
                else:
                    merged = dict(current) if current else dict(prev)

                frame["locals"] = sorted(merged.values(), key=lambda v: v["name"])
                current_seen[frame_id] = merged

            last_seen = current_seen

    def _attach_flow_nodes(self, steps: list[dict[str, Any]]) -> None:
        # Build a stable call tree across all steps.
        # Each distinct function activation gets its own node so the recursion
        # tree is accurate even when the same function is called multiple times
        # with identical (or no) arguments.
        seen_nodes: list[dict[str, Any]] = []
        seen_edges: list[dict[str, str]] = []
        node_index_by_key: dict[str, int] = {}
        edge_keys: set[str] = set()
        call_counter = 0
        prev_keys: list[str] = []

        for step in steps:
            active_keys: list[str] = []
            path = list(reversed(step["stack"]))
            step_nodes: list[str] = []
            current_keys: list[str] = []
            prefix_still_matches = True

            for depth, frame in enumerate(path):
                args = frame.get("args", []) or []
                args_str = ", ".join(args)
                base_key = f"{frame['name']}:{depth}:{args_str}"

                # Re-use the node from the previous step only when the entire
                # ancestor chain is identical and the frame itself matches.
                if prefix_still_matches and depth < len(prev_keys):
                    prev_key = prev_keys[depth]
                    prev_node = seen_nodes[node_index_by_key[prev_key]]
                    if prev_node.get("base_key") == base_key:
                        key = prev_key
                    else:
                        key = f"{base_key}:{call_counter}"
                        call_counter += 1
                        prefix_still_matches = False
                else:
                    key = f"{base_key}:{call_counter}"
                    call_counter += 1
                    prefix_still_matches = False

                current_keys.append(key)

                if key not in node_index_by_key:
                    node_index_by_key[key] = len(seen_nodes)
                    parent_key = active_keys[-1] if active_keys else None
                    seen_nodes.append({
                        "id": key,
                        "base_key": base_key,
                        "label": format_flow_label(frame["name"], args),
                        "function": frame["name"],
                        "params": args,
                        "meta": f"line {step['line']}",
                        "depth": depth,
                        "parentId": parent_key
                    })
                    if parent_key is not None:
                        edge_key = f"{parent_key}→{key}"
                        if edge_key not in edge_keys:
                            edge_keys.add(edge_key)
                            seen_edges.append({"from": parent_key, "to": key})
                step_nodes.append(key)
                active_keys.append(key)

            stack = step["stack"]
            nstack = len(stack)
            for si, frame in enumerate(stack):
                path_idx = nstack - 1 - si
                if path_idx < len(current_keys):
                    frame["id"] = current_keys[path_idx]
                else:
                    frame["id"] = f"{frame.get('name', 'fn')}|orphan|{si}"

            prev_keys = current_keys

            step["tree"] = {
                "nodes": [
                    {
                        **node,
                        "active": node["id"] == active_keys[-1] if active_keys else False,
                        "done": node["id"] not in active_keys
                    }
                    for node in seen_nodes
                ],
                "edges": [*seen_edges]
            }

class AppHandler(SimpleHTTPRequestHandler):
    tracer = CppTracer()

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self) -> None:
        if self.path != "/api/trace":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            code = payload.get("code", "")
            trace = self.tracer.trace(code)
            self._send_json(HTTPStatus.OK, trace)
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON payload."})
        except TraceError as exc:
            self._send_json(
                exc.status,
                {"error": exc.message, "details": exc.details}
            )
        except Exception as exc:
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "Unexpected tracing failure.", "details": str(exc)}
            )

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def empty_containers() -> dict[str, list[dict[str, Any]]]:
    return {
        "arrays": [],
        "maps": [],
        "sets": [],
        "stacks": [],
        "queues": [],
        "priorityQueues": [],
        "lists": [],
        "graphs": [],
        "unknowns": []
    }


def empty_memory_graph() -> dict[str, list[dict[str, str]]]:
    return {"nodes": [], "edges": []}


def merge_memory_graphs(
    memory_by_depth: dict[int, dict[str, list[dict[str, str]]]]
) -> dict[str, list[dict[str, str]]]:
    merged = empty_memory_graph()
    seen_nodes: set[str] = set()
    seen_edges: set[str] = set()

    for depth in sorted(memory_by_depth):
        graph = memory_by_depth[depth]
        for node in graph.get("nodes", []):
            node_id = node.get("id")
            if not node_id or node_id in seen_nodes:
                continue
            seen_nodes.add(node_id)
            merged["nodes"].append(node)
        for edge in graph.get("edges", []):
            source = edge.get("from")
            target = edge.get("to")
            if not source or not target:
                continue
            key = f"{source}->{target}|{edge.get('label', '')}"
            if key in seen_edges:
                continue
            seen_edges.add(key)
            merged["edges"].append(edge)

    return merged


def attach_container_address(payload: dict[str, Any], value_text: str) -> None:
    """When LLDB prints a hex address on the value line, keep it for the container card."""
    addr = normalize_address(extract_address(value_text))
    if addr:
        payload["address"] = addr


def merge_container_items_by_name(
    prev_items: list[dict[str, Any]],
    cur_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Prefer fresh LLDB fields but carry stable metadata (e.g. address) across steps when the new parse omits it."""
    if not cur_items:
        return list(prev_items)
    prev_by_name = {item["name"]: item for item in prev_items if item.get("name")}
    merged: list[dict[str, Any]] = []
    for item in cur_items:
        name = item.get("name")
        if not name or name not in prev_by_name:
            merged.append(dict(item))
            continue
        old = prev_by_name[name]
        combined = {**old, **item}
        new_addr = item.get("address")
        old_addr = old.get("address")
        if new_addr:
            combined["address"] = new_addr
        elif old_addr:
            combined["address"] = old_addr
        else:
            combined.pop("address", None)
        merged.append(combined)
    return merged


def merge_containers(
    containers_by_depth: dict[int, dict[str, list[dict[str, Any]]]]
) -> dict[str, list[dict[str, Any]]]:
    merged = empty_containers()
    seen = {
        "arrays": set(),
        "maps": set(),
        "sets": set(),
        "stacks": set(),
        "queues": set(),
        "priorityQueues": set(),
        "lists": set(),
        "graphs": set(),
        "unknowns": set()
    }

    for depth in sorted(containers_by_depth):
        containers = containers_by_depth[depth]
        for kind in ("arrays", "maps", "sets", "stacks", "queues", "priorityQueues", "lists", "graphs", "unknowns"):
            for item in containers.get(kind, []):
                key = item.get("name")
                if key in seen[kind]:
                    continue
                seen[kind].add(key)
                merged[kind].append(item)

    return merged


def format_flow_label(name: str, args: list[str]) -> str:
    return f"{name}({', '.join(args)})" if args else f"{name}()"


def split_function_signature(raw: str) -> tuple[str, list[str]]:
    """Extract display name and parameter list from an LLDB function string like `fib(int n)` or `main()`."""
    raw = raw.strip()
    match = re.match(r"^(?P<name>[^(]+)\((?P<inner>.*)\)$", raw)
    if not match:
        return raw, []

    name = match.group("name").strip()
    inner = match.group("inner").strip()
    if not inner:
        return name, []

    args = [part.strip().replace("=", " = ") for part in split_top_level(inner, ",") if part.strip()]
    return name, args


def dedupe_consecutive_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped = []
    previous_signature = None

    for step in steps:
        signature = (
            step["line"],
            json.dumps(step["stack"], sort_keys=True),
            json.dumps(step["containers"], sort_keys=True),
            json.dumps(step.get("memory") or {}, sort_keys=True),
        )
        if signature != previous_signature:
            deduped.append(step)
        previous_signature = signature

    return deduped


def find_declaration_lines(code: str) -> dict[str, int]:
    declarations: dict[str, int] = {}
    pattern = re.compile(
        r"(?:^|\s)(?:const\s+)?(?:std::\w+(?:<[^;]+>)?|\w+(?:<[^;]+>)?|unsigned|signed|long long|long|int|double|float|char|bool|string)\s+([^;{]+)"
    )

    for line_number, line in enumerate(code.splitlines(), start=1):
        for match in pattern.finditer(line):
            decl_list = match.group(1)
            parts = split_top_level(decl_list, ',')
            for part in parts:
                var_match = re.search(r'^[A-Za-z_]\w*', part.strip())
                if var_match:
                    declarations.setdefault(var_match.group(0), line_number)

    return declarations


def split_top_level(text: str, delimiter: str) -> list[str]:
    parts = []
    current = ""
    depth = 0
    for char in text:
        if char in '<({[':
            depth += 1
        elif char in '>)}]':
            depth -= 1
        elif char == delimiter and depth == 0:
            parts.append(current)
            current = ""
            continue
        current += char
    if current:
        parts.append(current)
    return parts


def parse_lldb_frame_var_line(row: str) -> tuple[str, str, str] | None:
    """Parse `(type) name = value` where `type` may contain parentheses (e.g. libstdc++ basic_string on Linux)."""
    row = row.strip()
    if not row.startswith("("):
        return None
    depth = 0
    for i, char in enumerate(row):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                typename = row[1:i].strip()
                rest = row[i + 1:].strip()
                match = re.match(r"^([A-Za-z_]\w*)\s*=\s*(.*)$", rest, re.DOTALL)
                if not match:
                    return None
                return typename, match.group(1), match.group(2)
    return None


def make_local(name: str, value: Any, typename: str) -> dict[str, Any]:
    return {"name": name, "value": value, "type": typename}


def lldb_strip_type_prefix(line: str) -> str:
    """Remove leading `(typename)` tokens LLDB prints with `frame variable -T` / typed children."""
    s = line.strip()
    while s.startswith("("):
        depth = 0
        i = 0
        closed = False
        while i < len(s):
            if s[i] == "(":
                depth += 1
            elif s[i] == ")":
                depth -= 1
                if depth == 0:
                    s = s[i + 1 :].lstrip()
                    closed = True
                    break
            i += 1
        if not closed:
            break
    return s


def is_nested_std_vector(typename: str) -> bool:
    if not is_vector_type(typename):
        return False
    return typename.count("vector") >= 2


def is_2d_row_major_values(values: Any) -> bool:
    if not isinstance(values, list) or not values:
        return False
    if not all(isinstance(row, list) for row in values):
        return False
    return all(not any(isinstance(x, list) for x in row) for row in values)


def merge_recursive_vector_heap_edges(
    memory: dict[str, list[dict[str, str]]],
    recursive_text: str,
) -> None:
    """Pair `frame variable -R` vector headers with the next `__begin_` line (libc++/libstdc++)."""
    if not recursive_text.strip():
        return
    queue: list[str] = []
    for raw in recursive_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        start = parse_lldb_frame_var_line(line)
        if start:
            tn, nm, vt = start
            if "vector" in tn and vt.rstrip().endswith("{"):
                queue.append(nm)
        match = re.search(r"__begin_\s*=\s*(0x[0-9a-fA-F]+)", line)
        if match and queue:
            var_name = queue.pop(0)
            addr = normalize_address(match.group(1))
            if addr:
                vid = f"var:{var_name}"
                add_memory_node(memory, vid, var_name, "variable")
                add_memory_node(memory, addr, addr, "address")
                add_memory_edge(memory, vid, addr, "__begin_")


def parse_frame_variables(
    text: str,
    current_line: int,
    declaration_lines: dict[str, int],
    recursive_text: str = "",
) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]], dict[str, list[dict[str, str]]]]:
    rows = [
        line.strip("\n")
        for line in text.splitlines()
        if line.strip() and not line.startswith("(lldb)") and "frame #" not in line
    ]

    variables: list[dict[str, Any]] = []
    containers = empty_containers()
    memory = empty_memory_graph()
    index = 0

    while index < len(rows):
        row = rows[index].strip()
        start = parse_lldb_frame_var_line(row)
        if not start:
            index += 1
            continue

        typename, name, value_text = start
        declaration_line = declaration_lines.get(name, -1)
        if declaration_line > current_line:
            index += 1
            if value_text.endswith("{"):
                while index < len(rows) and rows[index].strip() != "}":
                    index += 1
                index += 1
            continue

        if is_string_type(typename):
            vt = value_text.strip()
            if vt.startswith('"') and vt.endswith('"'):
                str_value = parse_literal(vt)
            elif vt.startswith("'") and vt.endswith("'") and len(vt) >= 2:
                str_value = vt[1:-1]
            else:
                str_value = vt.strip('"') or vt
            containers["arrays"].append({"name": name, "kind": "string", "values": list(str_value)})
            variables.append(make_local(name, str_value, typename))
            index += 1
            continue

        if is_map_type(typename) and value_text.startswith("size="):
            entries, next_index = parse_map(rows, index)
            if entries is not None:
                if is_graph_adjacency_map(entries):
                    containers["graphs"].append({"name": name, "edges": entries})
                else:
                    kind = "unordered_map" if "unordered_map" in typename else "map"
                    containers["maps"].append({"name": name, "kind": kind, "entries": entries})
                variables.append(make_local(name, dict(entries), typename))
                index = next_index
                continue

        if is_std_array_type(typename) and value_text == "{":
            values, next_index = parse_indexed_block(rows, index)
            if values is not None:
                containers["arrays"].append({"name": name, "kind": "array", "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_vector_type(typename) and value_text.startswith("size="):
            values, next_index = parse_vector(rows, index)
            if values is not None:
                if is_nested_std_vector(typename) and (not values or is_2d_row_major_values(values)):
                    containers["arrays"].append({"name": name, "kind": "matrix", "values": values})
                elif is_graph_adjacency_list(values):
                    containers["graphs"].append({"name": name, "edges": [[i, value] for i, value in enumerate(values)]})
                else:
                    containers["arrays"].append({"name": name, "kind": "vector", "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_vector_type(typename) and value_text.strip() == "{":
            values, next_index = parse_vector_curly(rows, index)
            if values is not None:
                if is_nested_std_vector(typename) and (not values or is_2d_row_major_values(values)):
                    containers["arrays"].append({"name": name, "kind": "matrix", "values": values})
                elif is_graph_adjacency_list(values):
                    containers["graphs"].append({"name": name, "edges": [[i, value] for i, value in enumerate(values)]})
                else:
                    containers["arrays"].append({"name": name, "kind": "vector", "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_set_type(typename) and value_text.startswith("size="):
            values, next_index = parse_set(rows, index)
            if values is not None:
                kind = "unordered_set" if "unordered_set" in typename else "set"
                containers["sets"].append({"name": name, "kind": kind, "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_stack_type(typename) and value_text == "{":
            values, next_index = parse_stack(rows, index)
            if values is not None:
                containers["stacks"].append({"name": name, "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_list_type(typename) and value_text.startswith("size="):
            values, next_index = parse_list(rows, index)
            if values is not None:
                containers["lists"].append({"name": name, "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_deque_type(typename) and value_text.startswith("size="):
            values, next_index = parse_deque(rows, index)
            if values is not None:
                containers["arrays"].append({"name": name, "kind": "deque", "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_queue_type(typename):
            if value_text.endswith("{}"):
                containers["queues"].append({"name": name, "values": []})
                variables.append(make_local(name, [], typename))
                index += 1
                continue
            values, next_index = parse_queue(rows, index)
            if values is not None:
                containers["queues"].append({"name": name, "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_priority_queue_type(typename):
            if value_text.endswith("{}"):
                containers["priorityQueues"].append({"name": name, "values": []})
                variables.append(make_local(name, [], typename))
                index += 1
                continue
            values, next_index = parse_priority_queue(rows, index)
            if values is not None:
                containers["priorityQueues"].append({"name": name, "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_vector_array_type(typename) and value_text == "{":
            values, next_index = parse_vector_array(rows, index)
            if values is not None:
                containers["arrays"].append({"name": name, "kind": "matrix", "values": values})
                variables.append(make_local(name, values, typename))
                index = next_index
                continue

        if is_pointer_type(typename):
            variable_id = f"var:{name}"
            add_memory_node(memory, variable_id, name, "variable")
            address = normalize_address(extract_address(value_text))
            if address:
                add_memory_node(memory, address, f"*{name}", "address")
                add_memory_edge(memory, variable_id, address, address)
                variables.append(make_local(name, address, typename))
            elif value_text.strip() in {"nullptr", "null", "0x0"}:
                variables.append(make_local(name, "nullptr", typename))
            if value_text.rstrip().endswith("{") and address:
                pointer_edges, next_index = parse_pointer_object_block(rows, index, address)
                for edge in pointer_edges:
                    add_memory_node(memory, edge["to"], edge["to"], "address")
                    add_memory_edge(memory, edge["from"], edge["to"], edge["label"])
                index = next_index
            else:
                index += 1
            continue

        if (typename.startswith("std::") or "<" in typename) and (value_text.startswith("size=") or value_text == "{"):
            if value_text.startswith("size="):
                values, next_index = parse_set(rows, index)
                if values is not None:
                    unk: dict[str, Any] = {"name": name, "kind": typename, "values": values}
                    attach_container_address(unk, value_text)
                    containers["unknowns"].append(unk)
                    variables.append(make_local(name, values, typename))
                    index = next_index
                    continue
            if value_text == "{":
                values, next_index = parse_indexed_block(rows, index)
                if values is not None:
                    unk = {"name": name, "kind": typename, "values": values}
                    attach_container_address(unk, value_text)
                    containers["unknowns"].append(unk)
                    variables.append(make_local(name, values, typename))
                    index = next_index
                    continue

        if value_text.endswith("{"):
            unk = {
                "name": name,
                "kind": typename,
                "values": [],
                "preview": "Expand in Locals or use a supported STL shape"
            }
            attach_container_address(unk, value_text)
            containers["unknowns"].append(unk)
            variables.append(make_local(name, f"⟨{typename}⟩", typename))
            index += 1
            while index < len(rows) and rows[index].strip() != "}":
                index += 1
            index += 1
            continue

        parsed_value = parse_literal(value_text)
        variables.append(make_local(name, parsed_value, typename))
        index += 1

    merge_recursive_vector_heap_edges(memory, recursive_text)
    annotate_memory_pointer_aliases(memory)
    return variables, containers, memory


def annotate_memory_pointer_aliases(memory: dict[str, list[dict[str, str]]]) -> None:
    """Tag address nodes so the UI can show p, q → @addr when several pointers share a target."""
    incoming_vars: dict[str, list[str]] = {}
    for edge in memory.get("edges", []):
        source = edge.get("from") or ""
        target = edge.get("to") or ""
        if not target or not source.startswith("var:"):
            continue
        name = source[4:]
        bucket = incoming_vars.setdefault(target, [])
        if name not in bucket:
            bucket.append(name)

    for node in memory.get("nodes", []):
        if node.get("kind") == "variable":
            continue
        addr = node.get("id") or ""
        names = incoming_vars.get(addr, [])
        if len(names) >= 2:
            node["pointedBy"] = sorted(names)


def _parse_vector_children(rows: list[str], index: int) -> tuple[list[Any], int]:
    values: list[Any] = []
    while index < len(rows):
        line = rows[index].strip()
        stripped = lldb_strip_type_prefix(line)
        if stripped == "}":
            return values, index + 1
        if re.match(r"^\[(\d+)\]\s*=\s*.+?\bsize=error", stripped, re.I):
            values.append([])
            index = scan_to_block_end(rows, index)
            continue
        if re.match(r"^\[(\d+)\]\s*=\s*.*\bsize=\d+\s*\{\s*$", stripped):
            nested_values, next_index = parse_nested_size_block(rows, index)
            values.append(nested_values)
            index = next_index
            continue
        value_match = re.match(r"^\[(\d+)\]\s*=\s*(.+)$", stripped)
        if value_match:
            values.append(parse_literal(value_match.group(2)))
        index += 1
    return values, index


def parse_vector(rows: list[str], start_index: int) -> tuple[list[Any] | None, int]:
    header = rows[start_index].strip()
    if re.search(r"size=error", header, re.I):
        if re.search(r"\{\s*\}", header):
            return [], start_index + 1
        return [], scan_to_block_end(rows, start_index)
    if re.search(r"size=\d+\s*\{\s*\}\s*$", header):
        return [], start_index + 1
    size_match = re.search(r"size=(\d+)", header)
    if not size_match:
        return None, start_index + 1

    size = int(size_match.group(1))
    if size > 2048:
        return None, scan_to_block_end(rows, start_index)

    values, next_i = _parse_vector_children(rows, start_index + 1)
    return values, next_i


def parse_vector_curly(rows: list[str], start_index: int) -> tuple[list[Any] | None, int]:
    header = rows[start_index].strip()
    if not header.rstrip().endswith("{"):
        return None, start_index + 1
    if re.search(r"\{\s*\}\s*$", header):
        return [], start_index + 1
    values, next_i = _parse_vector_children(rows, start_index + 1)
    return values, next_i


def parse_vector_array(rows: list[str], start_index: int) -> tuple[list[list[Any]] | None, int]:
    adjacency: list[list[Any]] = []
    index = start_index + 1
    while index < len(rows):
        line = rows[index].strip()
        stripped = lldb_strip_type_prefix(line)
        if stripped == "}":
            return adjacency, index + 1

        if re.match(r"^\[(\d+)\]\s*=\s*.*\bsize=\d+\s*\{\s*$", stripped):
            values, next_index = parse_nested_size_block(rows, index)
            adjacency.append(values)
            index = next_index
            continue

        simple_match = re.match(r"^\[(\d+)\]\s*=\s*\{\s*$", stripped)
        if simple_match:
            values, next_index = parse_indexed_block(rows, index)
            adjacency.append(values)
            index = next_index
            continue

        index += 1

    return adjacency, index


def parse_map(rows: list[str], start_index: int) -> tuple[list[list[Any]] | None, int]:
    size_match = re.search(r"size=(\d+)", rows[start_index])
    if not size_match:
        return None, start_index + 1

    size = int(size_match.group(1))
    if size > 512:
        return None, scan_to_block_end(rows, start_index)

    entries: list[list[Any]] = []
    index = start_index + 1
    while index < len(rows):
        line = rows[index].strip()
        if line == "}":
            return entries, index + 1
        entry_match = re.match(r'^\[(\d+)\]\s*=\s*\(first = (.+), second = (.+)\)$', line)
        if entry_match:
            second = entry_match.group(3)
            entries.append([parse_literal(entry_match.group(2)), parse_literal(second)])
        elif re.match(r'^\[(\d+)\]\s*=\s*\{$', line):
            key = None
            value: Any = None
            index += 1
            while index < len(rows):
                inner = rows[index].strip()
                if inner == "}":
                    break
                if inner.startswith("first = "):
                    key = parse_literal(inner.split("=", 1)[1].strip())
                elif re.match(r"^second = size=\d+\s*\{$", inner):
                    value, index = parse_named_size_block(rows, index)
                    continue
                elif inner.startswith("second = "):
                    value = parse_literal(inner.split("=", 1)[1].strip())
                index += 1
            entries.append([key, value])
        index += 1

    return entries, index


def parse_set(rows: list[str], start_index: int) -> tuple[list[Any] | None, int]:
    size_match = re.search(r"size=(\d+)", rows[start_index])
    if not size_match:
        return None, start_index + 1

    size = int(size_match.group(1))
    if size > 2048:
        return None, scan_to_block_end(rows, start_index)

    values = []
    index = start_index + 1
    while index < len(rows):
        line = rows[index].strip()
        if line == "}":
            return values, index + 1
        entry_match = re.match(r"^\[(\d+)\]\s*=\s*(.+)$", line)
        if entry_match:
            values.append(parse_literal(entry_match.group(2)))
        index += 1

    return values, index


def parse_deque(rows: list[str], start_index: int) -> tuple[list[Any] | None, int]:
    return parse_set(rows, start_index)


def parse_list(rows: list[str], start_index: int) -> tuple[list[Any] | None, int]:
    values = []
    index = start_index + 1
    while index < len(rows):
        line = rows[index].strip()
        if line == "}":
            return values, index + 1
        value_match = re.match(r"^\[(\d+)\]\s*=\s*(.+)$", line)
        if value_match:
            values.append(parse_literal(value_match.group(2)))
        index += 1
    return values, index


def parse_stack(rows: list[str], start_index: int) -> tuple[list[Any] | None, int]:
    values = []
    index = start_index + 1
    inside_storage = False

    while index < len(rows):
        line = rows[index].strip()
        if line.startswith("c = size="):
            inside_storage = True
            index += 1
            continue
        if line == "}" and inside_storage:
            inside_storage = False
            index += 1
            continue
        if line == "}":
            return values, index + 1

        entry_match = re.match(r"^\[(\d+)\]\s*=\s*(.+)$", line)
        if entry_match:
            values.append(parse_literal(entry_match.group(2)))

        index += 1

    return values, index


def parse_queue(rows: list[str], start_index: int) -> tuple[list[Any] | None, int]:
    values = []
    index = start_index + 1
    inside_storage = False

    while index < len(rows):
        line = rows[index].strip()
        if line.startswith("c = size="):
            inside_storage = True
            index += 1
            continue
        if line == "}" and inside_storage:
            inside_storage = False
            index += 1
            continue
        if line == "}":
            return values, index + 1

        entry_match = re.match(r"^\[(\d+)\]\s*=\s*(.+)$", line)
        if entry_match:
            values.append(parse_literal(entry_match.group(2)))
        index += 1

    return values, index


def parse_priority_queue(rows: list[str], start_index: int) -> tuple[list[Any] | None, int]:
    """Keep LLDB storage order (underlying heap layout), not a sorted view."""
    return parse_queue(rows, start_index)


def parse_nested_size_block(rows: list[str], start_index: int) -> tuple[list[Any], int]:
    values = []
    index = start_index + 1
    while index < len(rows):
        line = rows[index].strip()
        stripped = lldb_strip_type_prefix(line)
        if stripped == "}":
            return values, index + 1
        if re.match(r"^\[(\d+)\]\s*=\s*.+?\bsize=error", stripped, re.I):
            values.append([])
            index = scan_to_block_end(rows, index)
            continue
        if re.match(r"^\[(\d+)\]\s*=\s*.*\bsize=\d+\s*\{\s*$", stripped):
            nested_values, next_index = parse_nested_size_block(rows, index)
            values.append(nested_values)
            index = next_index
            continue
        value_match = re.match(r"^\[(\d+)\]\s*=\s*(.+)$", stripped)
        if value_match:
            values.append(parse_literal(value_match.group(2)))
        index += 1
    return values, index


def parse_indexed_block(rows: list[str], start_index: int) -> tuple[list[Any], int]:
    values = []
    index = start_index + 1
    while index < len(rows):
        line = rows[index].strip()
        stripped = lldb_strip_type_prefix(line)
        if stripped == "}":
            return values, index + 1
        value_match = re.match(r"^\[(\d+)\]\s*=\s*(.+)$", stripped)
        if value_match:
            values.append(parse_literal(value_match.group(2)))
        index += 1
    return values, index


def parse_named_size_block(rows: list[str], start_index: int) -> tuple[list[Any], int]:
    values = []
    index = start_index + 1
    while index < len(rows):
        line = rows[index].strip()
        stripped = lldb_strip_type_prefix(line)
        if stripped == "}":
            return values, index + 1
        if re.match(r"^\[(\d+)\]\s*=\s*.*\bsize=\d+\s*\{\s*$", stripped):
            nested_values, next_index = parse_nested_size_block(rows, index)
            values.append(nested_values)
            index = next_index
            continue
        value_match = re.match(r"^\[(\d+)\]\s*=\s*(.+)$", stripped)
        if value_match:
            values.append(parse_literal(value_match.group(2)))
        index += 1
    return values, index


def scan_to_block_end(rows: list[str], start_index: int) -> int:
    index = start_index + 1
    while index < len(rows) and rows[index].strip() != "}":
        index += 1
    return index + 1


def parse_pointer_object_block(
    rows: list[str],
    start_index: int,
    owner_address: str
) -> tuple[list[dict[str, str]], int]:
    edges: list[dict[str, str]] = []
    index = start_index + 1
    depth = 1
    while index < len(rows):
        line = rows[index].strip()
        if line.endswith("{"):
            depth += 1
        if line == "}":
            depth -= 1
            index += 1
            if depth <= 0:
                return edges, index
            continue

        pointer_member = re.match(
            r"^(?:\(([^)]+)\)\s+)?([A-Za-z_]\w*)\s*=\s*(0x[0-9a-fA-F]+|nullptr|null|0x0).*$",
            line
        )
        if pointer_member:
            member_name = pointer_member.group(2)
            target_address = normalize_address(pointer_member.group(3))
            if target_address:
                edges.append({
                    "from": owner_address,
                    "to": target_address,
                    "label": member_name
                })
        index += 1
    return edges, index


def is_string_type(typename: str) -> bool:
    return typename in ("std::string", "std::__1::string", "std::__cxx11::string", "string") or \
        "basic_string" in typename


def is_vector_type(typename: str) -> bool:
    return "std::vector" in typename or typename.startswith("vector<")


def is_std_array_type(typename: str) -> bool:
    return "std::array" in typename or typename.startswith("array<")


def is_vector_array_type(typename: str) -> bool:
    return is_nested_std_vector(typename)


def is_map_type(typename: str) -> bool:
    return (
        "std::map" in typename
        or "std::unordered_map" in typename
        or typename.startswith("map<")
        or typename.startswith("unordered_map<")
    )


def is_set_type(typename: str) -> bool:
    return (
        "std::set" in typename
        or "std::unordered_set" in typename
        or typename.startswith("set<")
        or typename.startswith("unordered_set<")
    )


def is_stack_type(typename: str) -> bool:
    return "std::stack" in typename or typename.startswith("stack<")


def is_list_type(typename: str) -> bool:
    return "std::list" in typename or typename.startswith("list<")


def is_deque_type(typename: str) -> bool:
    return "std::deque" in typename or typename.startswith("deque<")


def is_queue_type(typename: str) -> bool:
    return "std::queue" in typename or typename.startswith("queue<")


def is_priority_queue_type(typename: str) -> bool:
    return "std::priority_queue" in typename or typename.startswith("priority_queue<")


def is_pointer_type(typename: str) -> bool:
    return "*" in typename


def is_graph_adjacency_list(values: list[Any]) -> bool:
    return bool(values) and all(isinstance(item, list) for item in values)


def is_graph_adjacency_map(entries: list[list[Any]]) -> bool:
    return bool(entries) and all(len(item) == 2 and isinstance(item[1], list) for item in entries)


def parse_literal(raw: str) -> Any:
    value = raw.strip()
    if value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if re.fullmatch(r"-?\d+\.\d+", value):
        return float(value)
    if value in {"true", "false"}:
        return value == "true"
    return value


def extract_address(value_text: str) -> str | None:
    match = re.search(r"0x[0-9a-fA-F]+", value_text)
    return match.group(0) if match else None


def normalize_address(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.strip().lower()
    if normalized in {"0x0", "nullptr", "null"}:
        return None
    if normalized.startswith("0x"):
        body = normalized[2:].lstrip("0")
        normalized = f"0x{body or '0'}"
        if normalized == "0x0":
            return None
    return normalized


def add_memory_node(
    memory: dict[str, list[dict[str, str]]],
    node_id: str,
    label: str,
    kind: str
) -> None:
    if any(node.get("id") == node_id for node in memory["nodes"]):
        return
    memory["nodes"].append({"id": node_id, "label": label, "kind": kind})


def add_memory_edge(
    memory: dict[str, list[dict[str, str]]],
    source: str,
    target: str,
    label: str
) -> None:
    edge_key = f"{source}->{target}|{label}"
    if any(f"{edge.get('from')}->{edge.get('to')}|{edge.get('label', '')}" == edge_key for edge in memory["edges"]):
        return
    memory["edges"].append({"from": source, "to": target, "label": label})


def describe_event(function_name: str, line_number: int, line_text: str) -> str:
    normalized = line_text.strip()
    if normalized.startswith("return"):
        return f"Return from {function_name}"
    if "push_back" in normalized:
        return "Append to vector"
    if ".insert(" in normalized:
        return "Insert into set"
    if re.search(r"\w+\s*\[.*\]\s*=", normalized):
        return "Update associative entry"
    if re.search(r"\bif\s*\(", normalized):
        return f"Evaluate branch in {function_name}"
    if re.search(r"\bfor\s*\(", normalized):
        return f"Enter loop in {function_name}"
    if re.search(r"\bwhile\s*\(", normalized):
        return f"Evaluate loop in {function_name}"
    if re.search(r"\b(?:int|double|float|char|bool|std::vector|std::map|std::set|std::stack|vector|map|set|stack)\b", normalized):
        return f"Initialize state in {function_name}"
    return f"Execute line {line_number} in {function_name}"


def describe_summary(
    function_name: str,
    line_text: str,
    stack_depth: int,
    containers: dict[str, list[dict[str, Any]]]
) -> str:
    parts = [f"`{function_name}` is focused on `{line_text}`."]
    if stack_depth > 1:
        parts.append(f"Call depth is {stack_depth}, so recursion or nested flow is active.")
    if (
        containers["arrays"]
        or containers["maps"]
        or containers["sets"]
        or containers["stacks"]
        or containers["queues"]
        or containers["priorityQueues"]
        or containers["lists"]
        or containers["graphs"]
        or containers["unknowns"]
    ):
        parts.append("Container views were captured directly from the current frame.")
    else:
        parts.append("Scalar locals and stack shape are the important signals here.")
    return " ".join(parts)


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), AppHandler)
    print(f"Serving C++ Flow Studio at http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()