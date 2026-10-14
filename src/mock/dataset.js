/**
 * 模拟数据生成器
 *
 * 用固定种子的 PRNG，保证每次刷新拿到的数据组完全一致 —— 演示、截图、
 * 回归对比才有意义，否则「刚才那个复现不出来了」。
 *
 * 差异分布是刻意设计的，贴近真实批量比对的结果形态：
 *   过半完全一致（大部分报文本来就该一样）
 *   三成小幅差异（改了几个字段值，最需要行内高亮才能看清）
 *   一成结构性差异（增删字段、数组元素顺序变化）
 *   少量重大差异 / 单侧为空 / 报文损坏（暴露异常态）
 */

// ---------------------------------------------------------------------------
// 可复现的随机数
// ---------------------------------------------------------------------------

function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeRng(seed) {
    const rand = mulberry32(seed);
    const api = {
        next: rand,
        int(min, max) {
            return Math.floor(rand() * (max - min + 1)) + min;
        },
        pick(arr) {
            return arr[Math.floor(rand() * arr.length)];
        },
        chance(p) {
            return rand() < p;
        },
        amount(min, max) {
            return (rand() * (max - min) + min).toFixed(2);
        },
        shuffle(arr) {
            const out = arr.slice();
            for (let i = out.length - 1; i > 0; i -= 1) {
                const j = Math.floor(rand() * (i + 1));
                const tmp = out[i];
                out[i] = out[j];
                out[j] = tmp;
            }
            return out;
        }
    };
    return api;
}

function pad(n, w) {
    let s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
}

function digits(rng, n) {
    let s = '';
    for (let i = 0; i < n; i += 1) s += rng.int(0, 9);
    return s;
}

const TXN_CODES = ['CMT301', 'CMT302', 'CMT110', 'CMT120', 'CMT210', 'CMT901'];
const TXN_TYPES = ['消费', '退货', '预授权', '预授权完成', '转账', '代扣'];
const INSTITUTIONS = ['10000001', '10000002', '20010005', '30020011', '40030077'];
const CHANNELS = ['APP_IOS', 'APP_ANDROID', 'H5', 'MINI_PROGRAM', 'POS', 'OPEN_API'];
const RISK_LEVELS = ['LOW', 'MID', 'HIGH', 'REJECT'];
const MERCHANTS = ['星巴克国金中心店', '京东商城自营', '美团外卖-川菜小馆', '滴滴出行', '屈臣氏个人护理', '中国石化加油站'];
const GOODS = ['冷萃咖啡 大杯', '无线降噪耳机 Pro', '麻辣香锅 双人份', '快车 12.4 公里', '保湿面膜 5 片装', '95# 汽油 45.2L'];
const PAY_WAYS = ['WECHAT', 'ALIPAY', 'UNIONPAY', 'CREDIT', 'BALANCE'];
const RULE_POOL = [
    { id: 'R001', name: '夜间大额', score: 32 },
    { id: 'R007', name: '新设备首刷', score: 18 },
    { id: 'R013', name: '高频小额', score: 11 },
    { id: 'R021', name: '跨城交易', score: 27 },
    { id: 'R044', name: '商户黑名单命中', score: 88 },
    { id: 'R052', name: '卡片过期预警', score: 9 },
    { id: 'R068', name: '拆分交易嫌疑', score: 45 }
];

// ---------------------------------------------------------------------------
// XML：支付清算报文
// ---------------------------------------------------------------------------

function buildPayRecord(rng, seq) {
    const day = '20260930';
    const hour = rng.int(0, 23);
    const min = rng.int(0, 59);
    const sec = rng.int(0, 59);
    const ms = rng.int(0, 999);

    const ruleCount = rng.int(1, 4);
    const rules = rng.shuffle(RULE_POOL).slice(0, ruleCount);

    const base = {
        msgId: day + pad(hour, 2) + pad(min, 2) + pad(sec, 2) + pad(seq, 6),
        batchNo: 'B' + day + pad(rng.int(1, 12), 3),
        src: rng.pick(INSTITUTIONS),
        dst: rng.pick(INSTITUTIONS),
        ts: '2026-09-30T' + pad(hour, 2) + ':' + pad(min, 2) + ':' + pad(sec, 2) + '.' + pad(ms, 3),
        prio: rng.pick(['HIGH', 'NORMAL', 'LOW']),
        seq: pad(seq, 8),
        code: rng.pick(TXN_CODES),
        type: rng.pick(TXN_TYPES),
        amt: rng.amount(8, 26000),
        ccy: '156',
        date: day,
        time: pad(hour, 2) + pad(min, 2) + pad(sec, 2),
        term: digits(rng, 8),
        mer: digits(rng, 15),
        merName: rng.pick(MERCHANTS),
        goods: rng.pick(GOODS),
        acq: rng.pick(INSTITUTIONS),
        iss: rng.pick(INSTITUTIONS),
        pan: '62' + digits(rng, 6) + '******' + digits(rng, 4),
        acctType: rng.pick(['DEBIT', 'CREDIT', 'PREPAID']),
        holder: rng.pick(['张*', '李*明', '王*华', '赵*', '陈*军', '刘*婷']),
        exp: '2' + rng.int(7, 9) + pad(rng.int(1, 12), 2),
        settle: day,
        settleAmt: null, //. 下面按手续费算
        fee: rng.amount(0.1, 60),
        rate: (rng.next() * 0.006).toFixed(6),
        flag: rng.pick(['S', 'S', 'S', 'F', 'P']),
        risk: rng.pick(RISK_LEVELS),
        rules,
        channel: rng.pick(CHANNELS),
        device: 'DEV-' + digits(rng, 10),
        ip: rng.int(10, 223) + '.' + rng.int(0, 255) + '.' + rng.int(0, 255) + '.' + rng.int(1, 254),
        trace: digits(rng, 32),
        remark: rng.chance(0.4) ? rng.pick(['正常交易', '客户现场确认', '补录交易', '冲正后重发']) : ''
    };
    base.settleAmt = (parseFloat(base.amt) - parseFloat(base.fee)).toFixed(2);
    return base;
}

function renderPayXml(d, opts) {
    const o = opts || {};
    const rules = o.ruleOrder ? o.ruleOrder.map((i) => d.rules[i]).filter(Boolean) : d.rules;

    const ruleXml = rules
        .map(
            (r) =>
                '            <Rule>\n' +
                '              <RuleId>' + r.id + '</RuleId>\n' +
                '              <RuleName>' + r.name + '</RuleName>\n' +
                '              <Score>' + r.score + '</Score>\n' +
                '            </Rule>'
        )
        .join('\n');

    const extFields = o.extOrder || ['channel', 'deviceId', 'ip', 'traceId'];
    const extMap = {
        channel: d.channel,
        deviceId: d.device,
        ip: d.ip,
        traceId: d.trace
    };
    const extXml = extFields
        .filter((k) => extMap[k] != null)
        .map((k) => '      <Field name="' + k + '">' + extMap[k] + '</Field>')
        .join('\n');

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Package xsi:schemaLocation="urn:clearing:v2 clearing-2.1.xsd">\n' +
        '  <Header>\n' +
        '    <Version>' + (o.version || '2.1') + '</Version>\n' +
        '    <MsgType>' + d.code + '</MsgType>\n' +
        '    <MsgId>' + d.msgId + '</MsgId>\n' +
        '    <BatchNo>' + d.batchNo + '</BatchNo>\n' +
        '    <SrcInstId>' + d.src + '</SrcInstId>\n' +
        '    <DstInstId>' + d.dst + '</DstInstId>\n' +
        '    <SendTime>' + d.ts + '</SendTime>\n' +
        '    <Priority>' + d.prio + '</Priority>\n' +
        '  </Header>\n' +
        '  <Body>\n' +
        '    <TxnInfo>\n' +
        '      <TxnSeq>' + d.seq + '</TxnSeq>\n' +
        '      <TxnCode>' + d.code + '</TxnCode>\n' +
        '      <TxnType>' + d.type + '</TxnType>\n' +
        '      <TxnAmt>' + d.amt + '</TxnAmt>\n' +
        '      <Currency>' + d.ccy + '</Currency>\n' +
        '      <TxnDate>' + d.date + '</TxnDate>\n' +
        '      <TxnTime>' + d.time + '</TxnTime>\n' +
        '      <TermNo>' + d.term + '</TermNo>\n' +
        '      <MerNo>' + d.mer + '</MerNo>\n' +
        '      <MerName>' + d.merName + '</MerName>\n' +
        '      <Goods>' + d.goods + '</Goods>\n' +
        '      <AcqInsId>' + d.acq + '</AcqInsId>\n' +
        '      <IssInsId>' + d.iss + '</IssInsId>\n' +
        '    </TxnInfo>\n' +
        '    <AcctInfo>\n' +
        '      <Pan>' + d.pan + '</Pan>\n' +
        '      <AcctType>' + d.acctType + '</AcctType>\n' +
        '      <CardHolder>' + d.holder + '</CardHolder>\n' +
        '      <ExpireDate>' + d.exp + '</ExpireDate>\n' +
        '    </AcctInfo>\n' +
        '    <SettleInfo>\n' +
        '      <SettleDate>' + d.settle + '</SettleDate>\n' +
        '      <SettleAmt>' + d.settleAmt + '</SettleAmt>\n' +
        '      <FeeAmt>' + d.fee + '</FeeAmt>\n' +
        '      <Rate>' + d.rate + '</Rate>\n' +
        '      <SettleFlag>' + d.flag + '</SettleFlag>\n' +
        '    </SettleInfo>\n' +
        '    <RiskInfo>\n' +
        '      <RiskLevel>' + d.risk + '</RiskLevel>\n' +
        '      <RuleHits>\n' +
        ruleXml + '\n' +
        '      </RuleHits>\n' +
        '    </RiskInfo>\n' +
        (o.withRemark === false
            ? ''
            : '    <Remark>' + (d.remark || '') + '</Remark>\n') +
        '    <ExtFields>\n' +
        extXml + '\n' +
        '    </ExtFields>\n' +
        '  </Body>\n' +
        '</Package>\n'
    );
}

// ---------------------------------------------------------------------------
// JSON：订单同步报文
// ---------------------------------------------------------------------------

function buildOrderRecord(rng, seq) {
    const createdHour = rng.int(0, 23);
    const createdMin = rng.int(0, 59);
    const itemCount = rng.int(1, 4);

    const items = [];
    for (let i = 0; i < itemCount; i += 1) {
        items.push({
            skuId: 'SKU' + digits(rng, 9),
            title: rng.pick(GOODS),
            qty: rng.int(1, 5),
            price: parseFloat(rng.amount(9.9, 899)),
            promo: rng.chance(0.5) ? rng.pick(['FULL_100_MINUS_10', 'SECOND_HALF', 'NEW_USER', 'MEMBER_95']) : null
        });
    }

    const amount = items.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2);
    const discount = rng.chance(0.6) ? parseFloat(rng.amount(0, 80)) : 0;

    const keys = [
        'orderId', 'outerOrderNo', 'shopId', 'channel', 'status', 'amount', 'currency', 'payWay',
        'buyer', 'items', 'logistics', 'promotion', 'riskTags', 'extra', 'createdAt', 'updatedAt', 'traceId'
    ];

    const values = {
        orderId: 'ORD' + pad(seq, 10),
        outerOrderNo: 'OUT' + digits(rng, 16),
        shopId: 'SHOP' + digits(rng, 6),
        channel: rng.pick(CHANNELS),
        status: rng.pick(['PAID', 'PAID', 'PAID', 'SHIPPED', 'REFUNDING', 'CLOSED', 'WAIT_PAY']),
        amount: parseFloat(amount) - discount,
        currency: 'CNY',
        payWay: rng.pick(PAY_WAYS),
        buyer: {
            buyerId: 'U' + digits(rng, 10),
            nick: rng.pick(['云**', '风**', '夜**', 'star**', 'quiet**']),
            level: rng.int(0, 7),
            phone: '1' + rng.pick(['3', '5', '7', '8', '9']) + digits(rng, 2) + '****' + digits(rng, 4),
            realNameVerified: rng.chance(0.8)
        },
        items,
        logistics: {
            company: rng.pick(['SF', 'JD', 'YTO', 'ZTO', 'EMS']),
            trackingNo: digits(rng, 13),
            receiver: rng.pick(['张*', '李*', '王*', '赵*']),
            address: {
                province: rng.pick(['广东省', '浙江省', '江苏省', '北京市', '上海市', '四川省']),
                city: rng.pick(['深圳市', '杭州市', '南京市', '北京市', '上海市', '成都市']),
                district: rng.pick(['南山区', '西湖区', '鼓楼区', '海淀区', '徐汇区', '武侯区']),
                detail: rng.pick(['科技园南路 88 号', '文一西路 969 号', '中山北路 200 号', '中关村大街 1 号'])
            },
            promiseTime: '2026-10-0' + rng.int(1, 5) + ' ' + pad(rng.int(9, 20), 2) + ':00:00'
        },
        promotion: {
            couponId: discount > 0 ? 'CP' + digits(rng, 8) : null,
            discount,
            points: rng.int(0, 500),
            stacked: rng.chance(0.3)
        },
        riskTags: rng.shuffle(['NEW_DEVICE', 'NIGHT_ORDER', 'HIGH_AMOUNT', 'CROSS_CITY', 'FREQUENT_REFUND']).slice(0, rng.int(0, 3)),
        extra: {
            source: rng.pick(['search', 'recommend', 'cart', 'direct']),
            abBucket: 'B' + rng.int(1, 40),
            clientVersion: rng.int(6, 9) + '.' + rng.int(0, 20) + '.' + rng.int(0, 9),
            deviceId: 'DEV-' + digits(rng, 10)
        },
        createdAt: '2026-09-30 ' + pad(createdHour, 2) + ':' + pad(createdMin, 2) + ':' + pad(rng.int(0, 59), 2),
        updatedAt: '2026-09-30 ' + pad(Math.min(23, createdHour + rng.int(0, 2)), 2) + ':' + pad(rng.int(0, 59), 2) + ':' + pad(rng.int(0, 59), 2),
        traceId: digits(rng, 32)
    };

    return { keys, values };
}

function renderOrderJson(rec, opts) {
    const o = opts || {};
    const keys = o.keyOrder || rec.keys;
    const out = {};
    keys.forEach((k) => {
        let v = rec.values[k];
        if (v === undefined) return;
        if (o.overrides && Object.prototype.hasOwnProperty.call(o.overrides, k)) v = o.overrides[k];
        out[k] = v;
    });
    if (o.extraKeys) {
        Object.keys(o.extraKeys).forEach((k) => { out[k] = o.extraKeys[k]; });
    }
    return JSON.stringify(out, null, 2);
}

// ---------------------------------------------------------------------------
// XML：对账文件（一条记录里有多行明细，用来演示「大报文 + 局部差异」）
// ---------------------------------------------------------------------------

function buildReconRecord(rng, seq) {
    const rowCount = rng.int(18, 40);
    const rows = [];
    for (let i = 0; i < rowCount; i += 1) {
        rows.push({
            seq: i + 1,
            acct: '62' + digits(rng, 6) + '****' + digits(rng, 4),
            amt: rng.amount(-8000, 8000),
            bal: rng.amount(0, 500000),
            flag: rng.pick(['C', 'D', 'C', 'C']),
            time: pad(rng.int(0, 23), 2) + ':' + pad(rng.int(0, 59), 2) + ':' + pad(rng.int(0, 59), 2)
        });
    }
    return {
        fileId: 'RECON' + pad(seq, 8),
        orgId: rng.pick(INSTITUTIONS),
        bizDate: '20260930',
        currency: 'CNY',
        rows,
        count: rows.length,
        total: rows.reduce((s, r) => s + parseFloat(r.amt), 0).toFixed(2)
    };
}

function renderReconXml(d, opts) {
    const o = opts || {};
    const rows = o.rowOrder ? o.rowOrder.map((i) => d.rows[i]).filter(Boolean) : d.rows;
    const body = rows
        .map(
            (r) =>
                '    <Rec seq="' + r.seq + '">\n' +
                '      <Acct>' + r.acct + '</Acct>\n' +
                '      <Amt>' + r.amt + '</Amt>\n' +
                '      <Bal>' + r.bal + '</Bal>\n' +
                '      <DcFlag>' + r.flag + '</DcFlag>\n' +
                '      <TxnTime>' + r.time + '</TxnTime>\n' +
                '    </Rec>'
        )
        .join('\n');

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<ReconFile>\n' +
        '  <Meta>\n' +
        '    <FileId>' + d.fileId + '</FileId>\n' +
        '    <OrgId>' + d.orgId + '</OrgId>\n' +
        '    <BizDate>' + d.bizDate + '</BizDate>\n' +
        '    <Currency>' + d.currency + '</Currency>\n' +
        '  </Meta>\n' +
        '  <Records>\n' +
        body + '\n' +
        '  </Records>\n' +
        '  <Summary>\n' +
        '    <Count>' + (o.count != null ? o.count : d.count) + '</Count>\n' +
        '    <TotalAmt>' + (o.total != null ? o.total : d.total) + '</TotalAmt>\n' +
        '  </Summary>\n' +
        '</ReconFile>\n'
    );
}

// ---------------------------------------------------------------------------
// 变异策略：由左侧生成右侧
// ---------------------------------------------------------------------------

/**
 * @returns {{leftText:string, rightText:string, mutation:string}}
 */
function mutatePay(rng, seq) {
    const left = buildPayRecord(rng, seq);
    const roll = rng.next();

    if (roll < 0.5) {
        return { leftText: renderPayXml(left), rightText: renderPayXml(left), mutation: 'identical' };
    }
    if (roll < 0.78) {
        //. 小幅值差异：改金额 / 状态 / 时间戳 / 风险等级
        const right = Object.assign({}, left);
        const hits = rng.int(1, 3);
        for (let i = 0; i < hits; i += 1) {
            switch (rng.int(0, 4)) {
                case 0: right.amt = (parseFloat(right.amt) + parseFloat(rng.amount(-500, 500))).toFixed(2); right.settleAmt = (parseFloat(right.amt) - parseFloat(right.fee)).toFixed(2); break;
                case 1: right.flag = rng.pick(['S', 'F', 'P']); break;
                case 2: right.risk = rng.pick(RISK_LEVELS); break;
                case 3: right.ts = right.ts.replace(/\.\d{3}$/, '.' + pad(rng.int(0, 999), 3)); break;
                default: right.prio = rng.pick(['HIGH', 'NORMAL', 'LOW']);
            }
        }
        return { leftText: renderPayXml(left), rightText: renderPayXml(right), mutation: 'value' };
    }
    if (roll < 0.88) {
        //. 结构差异：风控规则命中项顺序变化 / 扩展字段顺序变化
        const right = Object.assign({}, left);
        if (rng.chance(0.5) && left.rules.length > 1) {
            const order = rng.shuffle(left.rules.map((r, i) => i));
            return { leftText: renderPayXml(left), rightText: renderPayXml(right, { ruleOrder: order }), mutation: 'reorder' };
        }
        const extOrder = rng.shuffle(['channel', 'deviceId', 'ip', 'traceId']);
        return { leftText: renderPayXml(left), rightText: renderPayXml(right, { extOrder }), mutation: 'reorder' };
    }
    if (roll < 0.93) {
        //. 字段增删
        return { leftText: renderPayXml(left), rightText: renderPayXml(left, { withRemark: false }), mutation: 'field' };
    }
    if (roll < 0.965) {
        //. 重大差异：几乎整份报文都变了
        const right = buildPayRecord(rng, seq + 7919);
        return { leftText: renderPayXml(left), rightText: renderPayXml(right), mutation: 'major' };
    }
    if (roll < 0.985) {
        return { leftText: renderPayXml(left), rightText: '', mutation: 'missing' };
    }
    //. 报文损坏：截断 + 标签不闭合
    const broken = renderPayXml(left).slice(0, rng.int(120, 400)) + '</Broken';
    return { leftText: renderPayXml(left), rightText: broken, mutation: 'broken' };
}

function mutateOrder(rng, seq) {
    const rec = buildOrderRecord(rng, seq);
    const roll = rng.next();

    if (roll < 0.52) {
        return { leftText: renderOrderJson(rec), rightText: renderOrderJson(rec), mutation: 'identical' };
    }
    if (roll < 0.8) {
        const overrides = {};
        const hits = rng.int(1, 4);
        for (let i = 0; i < hits; i += 1) {
            switch (rng.int(0, 5)) {
                case 0: overrides.status = rng.pick(['PAID', 'SHIPPED', 'REFUNDING', 'CLOSED']); break;
                case 1: overrides.amount = parseFloat((rec.values.amount + parseFloat(rng.amount(-200, 200))).toFixed(2)); break;
                case 2: overrides.payWay = rng.pick(PAY_WAYS); break;
                case 3: overrides.updatedAt = rec.values.updatedAt.replace(/:\d{2}$/, ':' + pad(rng.int(0, 59), 2)); break;
                case 4: overrides.promotion = Object.assign({}, rec.values.promotion, { discount: parseFloat(rng.amount(0, 100)) }); break;
                default: overrides.riskTags = rng.shuffle(['NEW_DEVICE', 'NIGHT_ORDER', 'HIGH_AMOUNT', 'CROSS_CITY', 'FREQUENT_REFUND']).slice(0, rng.int(0, 4));
            }
        }
        return { leftText: renderOrderJson(rec), rightText: renderOrderJson(rec, { overrides }), mutation: 'value' };
    }
    if (roll < 0.9) {
        //. 键顺序变化 —— 「忽略顺序」模式下应当判为一致，顺序敏感模式下则满屏差异。
        //. 这正是旧版最容易让人误判的场景，所以单独造一类出来。
        return { leftText: renderOrderJson(rec), rightText: renderOrderJson(rec, { keyOrder: rng.shuffle(rec.keys) }), mutation: 'keyorder' };
    }
    if (roll < 0.94) {
        const drop = rng.pick(rec.keys);
        const right = Object.assign({}, rec.values);
        delete right[drop];
        const keys = rec.keys.filter((k) => k !== drop);
        return { leftText: renderOrderJson(rec), rightText: renderOrderJson({ keys, values: right }), mutation: 'field' };
    }
    if (roll < 0.97) {
        const other = buildOrderRecord(rng, seq + 104729);
        return { leftText: renderOrderJson(rec), rightText: renderOrderJson(other), mutation: 'major' };
    }
    if (roll < 0.99) {
        return { leftText: renderOrderJson(rec), rightText: '', mutation: 'missing' };
    }
    const raw = renderOrderJson(rec);
    return { leftText: raw, rightText: raw.slice(0, rng.int(60, 200)) + ',,,', mutation: 'broken' };
}

function mutateRecon(rng, seq) {
    const rec = buildReconRecord(rng, seq);
    const roll = rng.next();

    if (roll < 0.46) {
        return { leftText: renderReconXml(rec), rightText: renderReconXml(rec), mutation: 'identical' };
    }
    if (roll < 0.76) {
        //. 改几行明细的金额 / 余额 / 借贷标志
        const right = Object.assign({}, rec, { rows: rec.rows.map((r) => Object.assign({}, r)) });
        const hits = rng.int(1, 4);
        for (let i = 0; i < hits; i += 1) {
            const idx = rng.int(0, right.rows.length - 1);
            const r = right.rows[idx];
            const f = rng.int(0, 2);
            if (f === 0) r.amt = (parseFloat(r.amt) + parseFloat(rng.amount(-300, 300))).toFixed(2);
            else if (f === 1) r.bal = (parseFloat(r.bal) + parseFloat(rng.amount(-1000, 1000))).toFixed(2);
            else r.flag = r.flag === 'C' ? 'D' : 'C';
        }
        right.total = right.rows.reduce((s, r) => s + parseFloat(r.amt), 0).toFixed(2);
        return { leftText: renderReconXml(rec), rightText: renderReconXml(right), mutation: 'value' };
    }
    if (roll < 0.88) {
        //. 明细顺序被打乱
        const order = rng.shuffle(rec.rows.map((r, i) => i));
        return { leftText: renderReconXml(rec), rightText: renderReconXml(rec, { rowOrder: order }), mutation: 'reorder' };
    }
    if (roll < 0.94) {
        //. 少了一行明细，汇总没跟着改 —— 典型的对账不平
        const right = Object.assign({}, rec, { rows: rec.rows.slice(0, rec.rows.length - 1) });
        return {
            leftText: renderReconXml(rec),
            rightText: renderReconXml(right, { count: rec.count, total: rec.total }),
            mutation: 'field'
        };
    }
    if (roll < 0.975) {
        const other = buildReconRecord(rng, seq + 31337);
        return { leftText: renderReconXml(rec), rightText: renderReconXml(other), mutation: 'major' };
    }
    return { leftText: renderReconXml(rec), rightText: '', mutation: 'missing' };
}

// ---------------------------------------------------------------------------
// 数据组定义
// ---------------------------------------------------------------------------

const GROUP_DEFS = [
    {
        id: 'pay-clearing',
        name: '支付清算批次 · 20260930',
        desc: '清算前置 vs 核心账务，顺序敏感',
        biz: '支付清算',
        count: 320,
        format: 'XML',
        ordered: 1,
        seed: 20260930,
        leftSuffix: 'CLR_A',
        rightSuffix: 'ACC_B',
        mutate: mutatePay
    },
    {
        id: 'order-sync',
        name: '订单同步 · 生产 vs 灰度',
        desc: '同一批订单在新老链路上的落地结果，忽略顺序',
        biz: '订单中心',
        count: 480,
        format: 'JSON',
        ordered: 0,
        seed: 77001123,
        leftSuffix: 'PROD',
        rightSuffix: 'GRAY',
        mutate: mutateOrder
    },
    {
        id: 'recon-file',
        name: '核心对账文件 · 日终',
        desc: '单条报文体量大（数十行明细），顺序敏感',
        biz: '对账平台',
        count: 150,
        format: 'XML',
        ordered: 1,
        seed: 5150233,
        leftSuffix: 'HOST',
        rightSuffix: 'CHAN',
        mutate: mutateRecon
    },
    {
        id: 'regression',
        name: '小样本回归 · 冒烟集',
        desc: '快速验证用的小数据集',
        biz: '测试平台',
        count: 24,
        format: 'XML / JSON',
        ordered: 1,
        seed: 424242,
        leftSuffix: 'BASE',
        rightSuffix: 'NEW',
        mutate: null //. 混合，见下面特殊处理
    },
    {
        id: 'stress',
        name: '压力组 · 800 条',
        desc: '用来验证分片调度和虚拟滚动是否真的扛得住',
        biz: '压测',
        count: 800,
        format: 'JSON',
        ordered: 0,
        seed: 90909091,
        leftSuffix: 'OLD',
        rightSuffix: 'NEW',
        mutate: mutateOrder
    }
];

/**
 * 生成一个数据组的全部记录。
 * 字段命名沿用旧接口（left_text / right_text / left_name / right_name / datagram_field_ordered），
 * 这样接真实后端时只需要换数据源，组件层不用改。
 */
export function buildGroup(def) {
    const rng = makeRng(def.seed);
    const records = [];

    for (let i = 0; i < def.count; i += 1) {
        const seq = i + 1;
        let m;
        let ordered = def.ordered;
        let biz = def.biz;
        let varBase;

        if (def.id === 'regression') {
            //. 混合组：三种报文轮流来，并且忽略顺序开关也是混合的
            const kind = i % 3;
            if (kind === 0) m = mutatePay(rng, seq);
            else if (kind === 1) m = mutateOrder(rng, seq);
            else m = mutateRecon(rng, seq);
            ordered = i % 2;
            biz = kind === 0 ? '支付清算' : kind === 1 ? '订单中心' : '对账平台';
            varBase = 'SMOKE_' + pad(seq, 3);
        } else {
            m = def.mutate(rng, seq);
            varBase = def.biz.slice(0, 2).toUpperCase() + '_' + pad(seq, 4);
        }

        records.push({
            id: def.id + '-' + pad(seq, 5),
            seq,
            groupId: def.id,
            bizLabel: biz,
            left_name: varBase + '_' + def.leftSuffix,
            right_name: varBase + '_' + def.rightSuffix,
            left_text: m.leftText,
            right_text: m.rightText,
            datagram_field_ordered: ordered,
            mutation: m.mutation,
            //. 比对前预置状态
            status: 'pending',
            stats: null,
            spark: '',
            leftText: m.leftText,
            rightText: m.rightText,
            format: def.format.indexOf('/') >= 0 ? '' : def.format.toLowerCase(),
            notes: [],
            durationMs: 0,
            error: null
        });
    }

    return records;
}

/** 数据组元信息（不含记录，供选择器渲染） */
export function getGroupDefs() {
    return GROUP_DEFS.map((d) => ({
        id: d.id,
        name: d.name,
        desc: d.desc,
        count: d.count,
        format: d.format,
        ordered: d.ordered
    }));
}

const cache = {};

/**
 * 取数据组的原始定义（含 mutate / seed），不触发记录生成。
 *
 * 之所以单独开一个口子而不是复用 getGroup：getGroup 会把生成结果缓存起来，
 * 而控制台需要的是「每次开始比对都是一份干净的 pending 记录」。
 * 缓存过的记录带着上一轮的 status，重置时会看到一半已完成的怪状态。
 */
export function getGroupDef(groupId) {
    return GROUP_DEFS.filter((d) => d.id === groupId)[0] || null;
}

/** 带缓存地取数据组，避免重复生成 */
export function getGroup(groupId) {
    const def = GROUP_DEFS.filter((d) => d.id === groupId)[0];
    if (!def) return null;
    if (!cache[groupId]) cache[groupId] = { def, records: buildGroup(def) };
    return cache[groupId];
}

export const MUTATION_LABEL = {
    identical: '完全一致',
    value: '字段值差异',
    reorder: '元素顺序差异',
    keyorder: '键顺序差异',
    field: '字段增删',
    major: '重大差异',
    missing: '单侧为空',
    broken: '报文损坏'
};
