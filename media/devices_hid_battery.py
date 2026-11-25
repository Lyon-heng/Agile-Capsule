"""无线外设电量读取（HID 直连，无需厂商软件）

适配层结构参考 github.com/sdparklab/Voltide（MIT）：
每个品牌一个 provider，各自负责自己的报文，互不影响。

已实现协议（报文细节来自 Voltide 的实机抓包注释 / Linux hid-pulsar 驱动）：
- Logitech  HID++ 2.0：0x1004 BATTERY_VOLTAGE(func1) / 0x1000 BATTERY_LEVEL(func0)，长报文 0x11，swId 0x0E
- Razer     91 字节 Feature：cmd 0x07/0x80，响应第 9 字节为电量
- VXE/ATK   17 字节输出报文（report 0x08，校验 0x55-sum）：0x03 探在线，0x04 取电量
- ATK       17 字节：0x08/0x04，校验和 (0x4D - sum(b1..15)) & 0xFF
- DAREU     17 字节：0x08/0x04，校验和 sum<55 ? 85-sum : 341-sum
- MCHOSE    65 字节 Feature（usage page 0xFF01）：report 0x11，cmd 0x06，payload XOR 0xFF

用法：
  python devices_hid_battery.py           # 输出 JSON
  python devices_hid_battery.py --debug   # 额外输出每个候选设备的原始报文
"""
import json
import re
import sys
import time

# 子进程 stdout 默认跟随系统区域（中文 Windows 为 GBK），Node 端按 UTF-8 解析会变乱码，
# 这里强制 UTF-8，保证中文设备名/品牌名能正确显示
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import hid
except Exception as e:
    print(json.dumps({"ok": False, "reason": "no-hidapi", "error": str(e)}))
    sys.exit(0)

DEBUG = "--debug" in sys.argv

VENDORS = {
    0x046D: "Logitech",
    0x1532: "Razer",
    0x373B: "ATK",
    0x260D: "DAREU",
    0x3554: "VXE",       # 3554 同时是 VXE / Pulsar / 迈从 的厂商号
    0x3837: "MCHOSE",
    0x258A: "MCHOSE",
    0x0B05: "ROG",
}


def log(*args):
    if DEBUG:
        print(*args, file=sys.stderr)


def classify(name, usage_page=0, usage=0):
    n = (name or "").lower()
    if any(k in n for k in ("keyboard", "keys", "k380", "k99", "z75", "k7 ", "keychron",
                            "filco", "hhkb", "g915", "g715", "tkl", "键盘")):
        return "keyboard"
    if any(k in n for k in ("headset", "headphone", "audio", "buds", "speaker", "耳机")):
        return "headset"
    if any(k in n for k in ("gamepad", "controller", "xbox", "dualsense", "dualshock", "手柄")):
        return "gamepad"
    if any(k in n for k in ("mouse", "mice", "g304", "g102", "g502", "g pro", "superlight",
                            "mx master", "mx anywhere", "viper", "deathadder", "basilisk",
                            "a5", "a7", "鼠标", "vxe", "vgn", "atk ")):
        return "mouse"
    if usage_page == 0x01 and usage == 0x02:
        return "mouse"
    if usage_page == 0x01 and usage == 0x06:
        return "keyboard"
    return "other"


def open_dev(path, nonblocking=False):
    d = hid.device()
    d.open_path(path)
    d.set_nonblocking(1 if nonblocking else 0)
    return d


def read_some(dev, size, timeout_ms=350):
    try:
        return dev.read(size, timeout_ms)
    except Exception:
        return None


# ---------------- Logitech HID++ 2.0 ----------------
def hpp_feature(dev, dev_index, feature_id, tries=2):
    """解析 featureId -> featureIndex；0 表示不支持（设备休眠时也会返回 0，故带重试）"""
def hpp_feature(dev, dev_index, feature_id, tries=2):
    """解析 featureId -> featureIndex；0 表示不支持（设备休眠时也会返回 0，故带重试）

    特性号字节序两种都试：规范是小端，但不少国产/兼容接收器按大端解析
    （罗技 LIGHTSPEED 兼容接收器就是大端，只发小端永远查不到型号）
    """
    lo, hi = feature_id & 0xFF, (feature_id >> 8) & 0xFF
    for i in range(tries):
        for b1, b2 in ((lo, hi), (hi, lo)):
            r = hpp(dev, 0x11, dev_index, 0x00, 0x00, bytes([b1, b2]), wait=0.35)
            if r and len(r) >= 5 and r[4]:
                return r[4]
        if i + 1 < tries:
            time.sleep(0.08)
    return None


def hpp_device_name(dev, dev_index, attempts=3):
    """feature 0x0005 DEVICE_NAME：拿到真实型号（接收器场景必有）"""
    for _ in range(attempts):
        fi = hpp_feature(dev, dev_index, 0x0005)
        if not fi:
            time.sleep(0.1)
            continue
        r = hpp(dev, 0x11, dev_index, fi, 0x00, wait=0.45)
        if not r or len(r) < 5:
            continue
        total = r[4]
        if not 0 < total <= 64:
            continue
        out = bytearray()
        idx = 0
        while idx < total:
            rr = hpp(dev, 0x11, dev_index, fi, 0x01, bytes([idx]), wait=0.45)
            if not rr or len(rr) < 6:
                break
            chunk = bytes(rr[4:4 + 16]).split(b"\x00")[0]
            if not chunk:
                break
            out += chunk
            idx += len(chunk)
        name = out.decode("utf-8", "ignore").strip()
        # 过滤控制字符/替换符，避免把乱码当型号显示
        name = "".join(ch for ch in name if ch.isprintable() and ch != "\ufffd")
        if name:
            return name
        time.sleep(0.1)
    return None


# 设备休眠/不支持时统一返回 0，用"是否支持某类专属特性"反推设备品类
KIND_FEATURES = ((0x2201, "mouse"), (0x2202, "mouse"),
                 (0x1B04, "keyboard"), (0x1802, "keyboard"), (0x1803, "keyboard"))


def hpp_kind(dev, dev_index):
    for fid, kind in KIND_FEATURES:
        if hpp_feature(dev, dev_index, fid, tries=1):
            log("kind feature hit", hex(fid), kind)
            return kind
    return None


def hpp(dev, report_id, dev_index, feature_index, func, params=b"", wait=0.3):
    size = 7 if report_id == 0x10 else 20
    buf = bytearray(size)
    buf[0] = report_id
    buf[1] = dev_index
    buf[2] = feature_index
    buf[3] = ((func & 0x0F) << 4) | 0x0E
    for i, b in enumerate(params[: size - 4]):
        buf[4 + i] = b
    try:
        dev.write(bytes(buf))
    except Exception as e:
        log("hpp write fail", e)
        return None
    deadline = time.time() + wait
    while time.time() < deadline:
        r = read_some(dev, 64, 100)
        if not r or len(r) < 5:
            continue
        if r[2] == feature_index and (r[3] & 0x0F) == 0x0E:
            if r[3] & 0x80:      # 错误报告（不支持的特性/无效参数），不能当数据用
                return None
            return r
    return None


def logitech_one(dev, di):
    # 0x1004 BATTERY_VOLTAGE, function 1 → 百分比（优先，读数最准）
    fi = hpp_feature(dev, di, 0x1004, tries=1)
    if fi:
        resp = hpp(dev, 0x11, di, fi, 0x01)
        log("logitech 0x1004", di, resp[:12] if resp else None)
        if resp and len(resp) >= 5:
            lvl = resp[4]
            if 0 < lvl <= 100:
                return {"level": lvl,
                        "charging": bool(resp[5] & 0x01) if len(resp) > 5 else False,
                        "protocol": "HID++/0x1004"}
    # 0x1000 BATTERY_LEVEL_STATUS, function 0（status >= 5 视为无效电池，丢弃）
    fi = hpp_feature(dev, di, 0x1000, tries=1)
    if fi:
        resp = hpp(dev, 0x11, di, fi, 0x00)
        log("logitech 0x1000", di, resp[:12] if resp else None)
        if resp and len(resp) >= 5:
            lvl = resp[4]
            st = resp[5] if len(resp) > 5 else 0
            if 0 < lvl <= 100 and st <= 4:
                return {"level": lvl, "charging": st in (1, 2),
                        "protocol": "HID++/0x1000"}
    return None


def logitech(path):
    """接收器下可挂多个设备（鼠标/键盘），逐个设备索引取电量+型号"""
    dev = open_dev(path)
    found = []
    budget = time.time() + 14
    try:
        # 设备休眠时接收器对任何请求都回"索引 0"：先用 0x1004 的索引号找出醒着的设备索引，
        # 后面直接从它开始扫，避免在 2~6 号空索引上白等好几秒
        first = None
        for di in (1, 2, 0xFF):
            if hpp_feature(dev, di, 0x1004, tries=1):
                first = di
                break
        if first is None:
            log("logitech asleep")
            return []
        order = [first] + [d for d in (1, 2, 0xFF) if d != first]
        for di in order:
            if time.time() > budget:
                break
            info = logitech_one(dev, di)
            if not info:
                continue
            info["dev_index"] = di
            # 型号要趁刚唤醒立刻问：设备一停手就休眠，之后再问只会回 0
            nm = hpp_device_name(dev, di)
            log("logitech name", di, nm)
            if nm:
                info["name"] = nm
            kd = classify(nm or "", 0, 0)
            if kd == "other" and time.time() < budget:
                kd = hpp_kind(dev, di) or kd
            info["kind"] = kd
            found.append((di, info))
            break          # 一个接收器一般只挂一个设备，命中就收工
    finally:
        try:
            dev.close()
        except Exception:
            pass
    log("logitech done", len(found), round(time.time() - (budget - 14), 2), "s")
    return [info for _, info in found]


# ---------------- Razer ----------------
def razer(path):
    dev = open_dev(path)
    try:
        buf = bytearray(91)
        buf[0] = 0x00
        buf[1] = 0x1F
        buf[5] = 0xFF
        buf[6] = 0x01
        buf[7] = 0x07
        buf[8] = 0x80
        try:
            dev.send_feature_report(bytes(buf))
        except Exception as e:
            log("razer write fail", e)
            return None
        r = read_some(dev, 91, 400)
        log("razer resp", r[:12] if r else None)
        if r and len(r) > 10:
            lvl = r[9]
            if 0 < lvl <= 100:
                return {"level": lvl, "charging": bool(r[10] & 0x01), "protocol": "Razer"}
    finally:
        try:
            dev.close()
        except Exception:
            pass
    return None


# ---------------- 17 字节通用（ATK / DAREU） ----------------
def frame17_dareu_sum(body):
    s = sum(body) & 0xFF
    return (85 - s) if s < 55 else (341 - s)


def probe17(path, checksum_mode):
    """checksum_mode: 'atk' = (0x4D - sum) & 0xFF, 'dareu' = 85/341 规则"""
    dev = open_dev(path)
    try:
        f = bytearray(17)
        f[0] = 0x08
        f[1] = 0x04
        if checksum_mode == "atk":
            f[16] = (0x4D - sum(f[1:16])) & 0xFF
        else:
            f[16] = frame17_dareu_sum(f[0:16]) & 0xFF
        ok = False
        # 这类接收器只认输出报文（WriteFile），feature report 会被直接忽略，
        # 所以先用 write，失败再退回 feature
        try:
            dev.write(bytes(f))
            ok = True
        except Exception:
            try:
                dev.send_feature_report(bytes(f))
                ok = True
            except Exception as e:
                log("17 write fail", e)
        if not ok:
            return None
        r = read_some(dev, 17, 700)
        log("17 resp", r if r else None)
        if not r or len(r) < 10:
            return None
        lvl = r[6]
        charge = r[7]
        if 0 < lvl <= 100:
            return {"level": lvl, "charging": charge in (1, 2), "protocol": checksum_mode.upper()}
    finally:
        try:
            dev.close()
        except Exception:
            pass
    return None


# ---------------- VXE / ATK / Pulsar（17 字节 0x08 帧，校验 0x55-sum） ----------------
# 协议来自 Linux hid-pulsar 驱动：0x03 = 在线状态（应答第 6 字节 1 表示在线），
# 0x04 = 电量（第 6 字节百分比，第 7 字节 1 表示有线/充电，第 8~9 字节为 mV）
PULSAR_MAGIC = 0x55
PULSAR_CMD_STATUS = 0x03
PULSAR_CMD_POWER = 0x04


def pulsar_frame(cmd):
    f = bytearray(17)
    f[0] = 0x08
    f[1] = cmd
    f[16] = (PULSAR_MAGIC - sum(f[0:16])) & 0xFF
    return bytes(f)


def pulsar_cmd(dev, cmd, tries=3, wait=0.45):
    """接收器常把回复滞后一拍，同一帧多发几次才能对上"""
    frame = pulsar_frame(cmd)
    for _ in range(tries):
        try:
            dev.write(frame)
        except Exception as e:
            log("pulsar write fail", e)
            return None
        deadline = time.time() + wait
        while time.time() < deadline:
            r = read_some(dev, 17, 60)
            if not r or len(r) < 17 or r[0] != 0x08:
                continue
            if ((sum(r[0:16]) + r[16]) & 0xFF) != PULSAR_MAGIC:   # 校验不过的丢弃
                continue
            if r[1] != cmd:
                continue
            return bytes(r)
    return None


def pulsar(path):
    dev = open_dev(path)
    try:
        st = pulsar_cmd(dev, PULSAR_CMD_STATUS)
        log("pulsar status", st[:8] if st else None)
        if not st or st[6] != 1:      # 0 = 鼠标休眠/未连接
            return None
        pw = pulsar_cmd(dev, PULSAR_CMD_POWER)
        log("pulsar power", pw[:12] if pw else None)
        if not pw:
            return None
        lvl = pw[6]
        if not 0 < lvl <= 100:
            return None
        return {"level": lvl, "charging": pw[7] == 1, "protocol": "VXE/ATK", "kind": "mouse",
                "mv": (pw[8] << 8) | pw[9]}
    finally:
        try:
            dev.close()
        except Exception:
            pass
    return None


# ---------------- MCHOSE 65 字节 Feature ----------------
def mchose(path):
    dev = open_dev(path)
    try:
        frame = bytearray(66)
        frame[0] = 0x11
        frame[1] = 0x06 ^ 0xFF
        for i in range(2, 66):
            frame[i] = 0xFF
        try:
            dev.send_feature_report(bytes(frame))
        except Exception as e:
            log("mchose write fail", e)
            return None
        # 等待 "e5 06" 通知，再取 feature
        deadline = time.time() + 0.6
        acked = False
        while time.time() < deadline:
            r = read_some(dev, 65, 150)
            if r and len(r) >= 2 and (r[1] ^ 0xFF) == 0x06:
                acked = True
                break
        payload = None
        try:
            got = dev.get_feature_report(0x11, 65)
            if got and len(got) > 12:
                payload = bytes(b ^ 0xFF for b in got)
        except Exception as e:
            log("mchose get fail", e)
        if not payload:
            return None
        log("mchose payload", payload[:14])
        lvl = payload[9] if len(payload) > 9 else 0
        if 0 < lvl <= 100:
            return {"level": lvl, "charging": payload[10] in (1, 2) if len(payload) > 10 else False,
                    "protocol": "MCHOSE"}
    finally:
        try:
            dev.close()
        except Exception:
            pass
    return None


PROVIDERS = {
    0x046D: ("Logitech", logitech),
    0x1532: ("Razer", razer),
    # ATK / VXE 有两套 17 字节协议，先试 Pulsar 系（带在线状态校验），失败再退回旧 ATK 帧
    0x373B: ("ATK", lambda p: pulsar(p) or probe17(p, "atk")),
    0x260D: ("DAREU", lambda p: probe17(p, "dareu")),
    0x3554: ("VXE", lambda p: pulsar(p) or mchose(p)),
    0x3837: ("MCHOSE", mchose),
    0x258A: ("MCHOSE", lambda p: probe17(p, "atk")),
}

CN_BRAND = {"Logitech": "罗技", "Razer": "雷蛇", "ATK": "ATK", "DAREU": "达尔优",
            "VXE": "VXE", "MCHOSE": "迈从", "ROG": "ROG"}

# 产品名里的 "1K Dongle" / "USB Receiver" 只是接收器，去掉后才是设备名
DONGLE_SUFFIX_RE = re.compile(r"[\s\-_]*(1k|2k|4k|8k)?[\s\-_]*(dongle|receiver|接收器)\s*$", re.I)

# 接收器不报型号，只能靠 PID 认（来源：ATK/VXE 公开的 2.4G/有线 PID 表）
ATK_PID_MODEL = {
    (0x3554, 0xF58E): "VXE R1 SE+", (0x3554, 0xF58F): "VXE R1 SE+",
    (0x3554, 0xF58A): "VXE R1 Pro Max", (0x3554, 0xF58C): "VXE R1 Pro Max",
    (0x3554, 0xF503): "VGN F1 Pro", (0x3554, 0xF502): "VGN F1 Pro",
    (0x3554, 0xFB3E): "VGN F2 Pro Max", (0x3554, 0xFB3D): "VGN F2 Pro Max",
    (0x3554, 0x104D): "VXE MAD R", (0x3554, 0x103F): "VXE MAD R",
    (0x3554, 0x1040): "VXE MAD R Major Plus", (0x3554, 0x104C): "VXE MAD R Major Plus",
    (0x373B, 0x1031): "ATK F1 Ultimate", (0x373B, 0x102E): "ATK F1 Ultimate",
    (0x373B, 0x11D9): "ATK A9 Ultimate", (0x373B, 0x11B6): "ATK A9 Ultimate",
    (0x3554, 0x1085): "VXE R1 SE+",
}

# G HUB 等软件创建的虚拟键鼠，查了也没电量
VIRTUAL_DEVICES = {(0x046D, 0xC232), (0x046D, 0xC231), (0x046D, 0xC24F), (0x046D, 0x0ABF)}

# 接收器只会报 "USB Receiver"，用它当名字没意义，换成品类兜底名
GENERIC_NAME = ("usb receiver", "receiver", "接收器", "wireless receiver",
                "usb 输入设备", "usb input device")


def main():
    try:
        catalog = hid.enumerate()
    except Exception as e:
        print(json.dumps({"ok": False, "reason": "enumerate-failed", "error": str(e)}))
        return

    # 同一 vid:pid 可能有多个 HID 集合，优先厂商自定义集合（usage_page >= 0xFF00）
    groups = {}
    for d in catalog:
        vid = d.get("vendor_id")
        if not vid or not d.get("path"):
            continue
        if vid not in PROVIDERS:
            continue
        if (vid, d.get("product_id")) in VIRTUAL_DEVICES:
            continue
        if "virtual" in (d.get("product_string") or "").lower():
            continue
        groups.setdefault((vid, d.get("product_id")), []).append(d)

    results = []
    seen = set()
    for (vid, pid), entries in groups.items():
        brand, fn = PROVIDERS[vid]
        # 一个物理设备会枚举出多个 HID 集合，只挑厂商自定义集合探测，最多试 2 条
        pref = [e for e in entries if (e.get("usage_page") or 0) >= 0xFF00]
        pref.sort(key=lambda e: 0 if (e.get("usage") or 0) in (0x01, 0x02) else 1)
        tries = (pref or entries)[:2]
        infos = None
        for e in tries:
            try:
                infos = fn(e.get("path"))
            except Exception as ex:
                log("provider error", brand, ex)
                infos = None
            if infos:
                log("provider hit", brand, hex(vid), hex(pid or 0), e.get("usage_page"))
                if isinstance(infos, dict):
                    infos = [infos]
                break
        if not infos:
            continue
        prod = next((e.get("product_string") for e in entries if e.get("product_string")), "")
        for info in infos:
            di = info.get("dev_index") or 0
            name = info.get("name") or ATK_PID_MODEL.get((vid, pid or 0)) or prod or f"{brand} {vid:04X}:{pid or 0:04X}"
            if name.strip().lower() in GENERIC_NAME or "receiver" in name.lower():
                # 接收器自报的名字没有意义，换成品类兜底名；多个设备靠序号区分
                base = CN_BRAND.get(brand, brand)
                if di and di != 0xFF:
                    name = f"{base}无线设备 {di}"
                else:
                    name = base + "无线设备"
            else:
                # "VXE Mouse 1K Dongle" → "VXE Mouse"，型号名比接收器名有用
                cleaned = DONGLE_SUFFIX_RE.sub("", name).strip(" -_")
                if cleaned and len(cleaned) >= 3:
                    name = cleaned
            key = f"{name.lower()}|{di}"
            if key in seen:
                continue
            seen.add(key)
            results.append({
                "id": f"{vid:04X}-{(pid or 0):04X}-{di}",
                "name": name,
                "kind": info.get("kind") or classify(name, 0, 0),
                "level": info["level"],
                "charging": info.get("charging", False),
                "conn": "2.4G",
                "protocol": info.get("protocol", brand),
                "stale": False,
            })

    print(json.dumps({"ok": True, "count": len(results), "devices": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
