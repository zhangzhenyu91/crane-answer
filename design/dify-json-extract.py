# -*- coding: utf-8 -*-
"""
Dify 自定义代码节点脚本（MiMo 等不支持结构化输出的模型适用）。
WF1 / WF2 / WF1c 三段各自完整自包含（含 import），整段复制粘贴即可，入口函数均为 main。
WF1c（交跨报送提取）配置在 treeWatch 规则每群的「交跨提取 API Key」（可空，留空=该群不启用
交跨排查）；WF2c（交跨更正提取）对应「交跨更正 API Key」，代码段输出与 WF2 相同
（action / patches / reason），直接复用 WF2 段即可。

接线（各段相同）：LLM 节点输出 → 代码节点输入变量 text（String）。

输出变量（逐个声明，与代码 return 的键一一对应）：
- WF1：is_tree_hazard / line_name / pole_from / pole_to / position_note / side /
  distance / tree_species / tree_count / horizontal / vertical / over_height /
  diameter / status_note —— 全部 String（数值字段可能为空串，勿声明为 Number）
- WF1c：is_crossing / line_name / pole_from / pole_to / crossing_type / side /
  distance / cross_horizontal / cross_vertical / cross_angle / has_hazard / remark
  —— 全部 String（数值字段可能为空串，勿声明为 Number）
- WF2 / WF2c：action（String）、patches（Object）、reason（String）（WF2 另有 status，WF2c 不输出）
结束节点按同名变量逐个输出。本项目端直接读取 outputs 下各字段。

兼容：markdown 围栏、首尾废话、尾随逗号、数字带单位（"50米"/"10棵"/"90度"）。
解析失败：WF1/WF1c 返回 is_tree_hazard / is_crossing="false"（记录丢弃不打断流程），WF2/WF2c 返回 action="none"。
"""

# ============================================================
# WF1 · 报送提取（复制本段全部内容到 Dify 代码节点）
# ============================================================
import json
import re


def main(text: str) -> dict:
    cleaned = re.sub(r"```(?:json|JSON)?", "", str(text or ""))
    start, end = cleaned.find("{"), cleaned.rfind("}")
    data = {}
    if 0 <= start < end:
        try:
            data = json.loads(re.sub(r",\s*([}\]])", r"\1", cleaned[start:end + 1]))
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}

    def num(v):
        if v is None or isinstance(v, bool):
            return ""
        s = re.sub(r"(?:米|m|M|棵|cm|CM|厘米)$", "", str(v).strip())
        if not re.fullmatch(r"-?\d+(?:\.\d+)?", s):
            return ""
        f = float(s)
        return str(int(f)) if f.is_integer() else str(f)

    def txt(v):
        return "" if v is None else str(v).strip()

    hazard = data.get("is_tree_hazard")
    return {
        "is_tree_hazard": "true" if hazard in (True, "true", "True", "1", "是") else "false",
        "line_name": txt(data.get("line_name")),
        "pole_from": num(data.get("pole_from")),
        "pole_to": num(data.get("pole_to")),
        "position_note": txt(data.get("position_note")),
        "side": txt(data.get("side")),
        "distance": num(data.get("distance")),
        "tree_species": txt(data.get("tree_species")),
        "tree_count": num(data.get("tree_count")),
        "horizontal": num(data.get("horizontal")),
        "vertical": num(data.get("vertical")),
        "over_height": num(data.get("over_height")),
        "diameter": num(data.get("diameter")),
        "status_note": txt(data.get("status_note")),
    }


# ============================================================
# WF2 · 更正提取（复制本段全部内容到 Dify 代码节点）
# ============================================================
import json
import re


def main(text: str) -> dict:
    cleaned = re.sub(r"```(?:json|JSON)?", "", str(text or ""))
    start, end = cleaned.find("{"), cleaned.rfind("}")
    data = {}
    if 0 <= start < end:
        try:
            data = json.loads(re.sub(r",\s*([}\]])", r"\1", cleaned[start:end + 1]))
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    patches = data.get("patches")
    if not isinstance(patches, (dict, list)):
        patches = None
    return {
        "action": str(data.get("action") or "none"),
        "patches": patches,
        "status": "" if data.get("status") is None else str(data.get("status")).strip(),
        "reason": "" if data.get("reason") is None else str(data.get("reason")).strip(),
    }


# ============================================================
# WF1c · 交跨报送提取（复制本段全部内容到 Dify 代码节点）
# ============================================================
import json
import re


def main(text: str) -> dict:
    cleaned = re.sub(r"```(?:json|JSON)?", "", str(text or ""))
    start, end = cleaned.find("{"), cleaned.rfind("}")
    data = {}
    if 0 <= start < end:
        try:
            data = json.loads(re.sub(r",\s*([}\]])", r"\1", cleaned[start:end + 1]))
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}

    def num(v):
        if v is None or isinstance(v, bool):
            return ""
        s = re.sub(r"(?:米|m|M|度|棵|cm|CM|厘米)$", "", str(v).strip())
        if not re.fullmatch(r"-?\d+(?:\.\d+)?", s):
            return ""
        f = float(s)
        return str(int(f)) if f.is_integer() else str(f)

    def txt(v):
        return "" if v is None else str(v).strip()

    crossing = data.get("is_crossing")
    return {
        "is_crossing": "true" if crossing in (True, "true", "True", "1", "是") else "false",
        "line_name": txt(data.get("line_name")),
        "pole_from": num(data.get("pole_from")),
        "pole_to": num(data.get("pole_to")),
        "crossing_type": txt(data.get("crossing_type")),
        "side": txt(data.get("side")),
        "distance": num(data.get("distance")),
        "cross_horizontal": num(data.get("cross_horizontal")),
        "cross_vertical": num(data.get("cross_vertical")),
        "cross_angle": num(data.get("cross_angle")),
        "has_hazard": txt(data.get("has_hazard")),
        "remark": txt(data.get("remark")),
    }
