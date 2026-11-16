"""Native bounded analytics. No eval, generated Python, network, or file access."""
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, getcontext
import math
import statistics

# Bounded input magnitudes/scales, including weighted products and 10k-row sums.
# The default precision of 28 would silently erase small changes in large totals.
getcontext().prec = 512


def number(value):
    if value is None or isinstance(value, bool):
        raise ValueError('数值缺失；必须明确缺失值口径，不能自动填零')
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise ValueError('无法按十进制解析数值：' + str(value)[:80])
    if not result.is_finite() or abs(result) > Decimal('1e100') or abs(result.as_tuple().exponent) > 100 or len(result.as_tuple().digits) > 200:
        raise ValueError('数值非有限或超过预算')
    return result


def integer(value, low, high):
    n = number(value)
    if n != n.to_integral_value() or not low <= n <= high:
        raise ValueError('整数参数超出范围')
    return int(n)


def utc(value):
    t = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if t.tzinfo is None:
        raise ValueError('事件时间须包含时区偏移或 Z')
    return t.astimezone(timezone.utc)


def require(params, *keys):
    for key in keys:
        if key not in params or params[key] is None or params[key] == '':
            raise ValueError('缺少方法参数：' + key)


def compute(method, names, values, p):
    if not isinstance(p, dict):
        raise ValueError('params 必须是对象')
    rows = [dict(zip(names, row)) for row in values]
    def column(key):
        require(p, key)
        if p[key] not in names:
            raise ValueError('列不存在：' + str(p[key]))
        return p[key]
    warnings, checks = [], []
    output = []
    extra = {}
    if method == 'clean':
        trim = p.get('trim', [])
        if not isinstance(trim, list) or any(c not in names for c in trim):
            raise ValueError('trim 必须是已有列名数组')
        if not isinstance(p.get('deduplicate', False), bool):
            raise ValueError('deduplicate 必须为布尔值')
        seen, changed, removed = set(), 0, 0
        for row in rows:
            clean = {k: (v.strip() if k in trim and v is not None else v) for k, v in row.items()}
            changed += clean != row
            key = tuple(clean.values())
            if p.get('deduplicate', False) and key in seen:
                removed += 1
                continue
            seen.add(key)
            output.append(clean)
        outliers=[]
        for field in p.get('outlier_columns', []):
            if field not in names: raise ValueError('异常值列不存在')
            nums=[(i+1,number(r[field])) for i,r in enumerate(output) if r[field] is not None]
            if len(nums)<4:
                outliers.append({'column':field,'status':'insufficient-sample','count':len(nums)})
                continue
            q1,_,q3=statistics.quantiles([v for _,v in nums],n=4,method='inclusive'); spread=q3-q1
            low,high=q1-Decimal('1.5')*spread,q3+Decimal('1.5')*spread
            outliers.append({'column':field,'method':'1.5 IQR inclusive quartiles','low':str(low),'high':str(high),'flaggedRows':[i for i,v in nums if v<low or v>high],'evaluatedRows':len(nums)})
        extra = {'beforeRows': len(rows), 'afterRows': len(output), 'changedRows': changed, 'removedDuplicates': removed,'outliers':outliers}
        checks.append({'name': '清洗行数守恒', 'passed': len(rows) == len(output) + removed})
        warnings.append('仅执行显式 trim/整行去重；未自动删除缺失值或异常值。清洗后的空字符串仍保留为空字符串。')
    elif method == 'metric':
        value = column('value')
        mode = p.get('mode', 'sum')
        if mode not in ('sum', 'ratio', 'weighted_mean'):
            raise ValueError('mode 应为 sum/ratio/weighted_mean')
        denominator = column('denominator') if mode == 'ratio' else None
        weight = column('weight') if mode == 'weighted_mean' else None
        groups = p.get('group_by', [])
        if not isinstance(groups, list) or any(c not in names for c in groups):
            raise ValueError('group_by 必须是列名数组')
        key = p.get('unique_key')
        if key:
            if key not in names or any(r[key] is None for r in rows) or len({r[key] for r in rows}) != len(rows):
                raise ValueError('unique_key 非唯一或存在缺失，先核对粒度与重复')
        filters = p.get('filters', {})
        if not isinstance(filters, dict) or any(k not in names for k in filters):
            raise ValueError('filters 必须是已有列的精确等值条件')
        selected = [r for r in rows if all(r[k] == v for k, v in filters.items())]
        buckets = defaultdict(list)
        for r in selected:
            buckets[tuple(r[k] for k in groups)].append(r)
        if len(buckets) > 100:
            raise ValueError('分组超过100组')
        for group, records in sorted(buckets.items(), key=lambda kv: str(kv[0])):
            vals = [number(r[value]) for r in records]
            if weight:
                weights = [number(r[weight]) for r in records]
                if any(w < 0 for w in weights):
                    raise ValueError('权重不得为负')
                numerator = sum((v*w for v,w in zip(vals,weights)), Decimal(0))
                denom = sum(weights, Decimal(0))
            else:
                numerator = sum(vals, Decimal(0))
                denom = sum((number(r[denominator]) for r in records), Decimal(0)) if denominator else Decimal(1)
            result = numerator / denom if denom else None
            # Independent SQL recomputation uses bounded DECIMAL and the same selected rows.
            import duckdb
            con = duckdb.connect(config={'enable_external_access':'false','threads':'1','memory_limit':'256MB'})
            try:
                con.execute('CREATE TABLE verify(v DECIMAL(38,10), w DECIMAL(38,10), d DECIMAL(38,10))')
                con.executemany('INSERT INTO verify VALUES (?,?,?)', [(str(v), str(number(r[weight])) if weight else '1', str(number(r[denominator])) if denominator else '1') for v,r in zip(vals,records)])
                other = con.execute('SELECT SUM(v*w), SUM(w), SUM(d) FROM verify').fetchone()
                expected = number(other[0]) / (number(other[1]) if weight else number(other[2]) if denominator else Decimal(1)) if denom else None
                passed = result is None and expected is None or result is not None and expected is not None and abs(result-expected) <= Decimal('1e-8')*max(Decimal(1),abs(result))
                if not passed:
                    raise ValueError('十进制与 SQL 双路复算不一致')
                checks.append({'name': 'Decimal/SQL 双路复算', 'passed': passed})
            finally:
                con.close()
            output.append({**dict(zip(groups,group)), 'rows':len(records), 'numerator':str(numerator), 'denominator':str(denom) if mode != 'sum' else None, 'value':str(result) if result is not None else None})
        extra = {'includedRows':len(selected),'excludedRows':len(rows)-len(selected), 'mode':mode}
        warnings.append('比率是分子总和/分母总和，不是行级百分比平均；分母为零返回空值。')
    elif method == 'reconcile':
        side, key, value = column('side'), column('key'), column('value')
        if any(r[side] not in ('left','right') or r[key] is None for r in rows):
            raise ValueError('side 必须为 left/right，关联键不得缺失')
        sides = {s:[r for r in rows if r[side]==s] for s in ('left','right')}
        freq = {s:Counter(r[key] for r in v) for s,v in sides.items()}
        for k in sorted(set(freq['left']) | set(freq['right'])):
            l,r = freq['left'][k],freq['right'][k]
            ls = sum((number(v[value]) for v in sides['left'] if v[key]==k),Decimal(0))
            rs = sum((number(v[value]) for v in sides['right'] if v[key]==k),Decimal(0))
            output.append({'key':k,'leftRows':l,'rightRows':r,'innerJoinRows':l*r,'manyToMany':l>1 and r>1,'leftTotal':str(ls),'rightTotal':str(rs),'difference':str(ls-rs)})
        extra={'expectedInnerJoinRows':sum(r['innerJoinRows'] for r in output),'leftRows':len(sides['left']),'rightRows':len(sides['right'])}
        warnings.append('按真实键频率计算关联膨胀；没有执行会复制金额的原始多对多合并。')
    elif method == 'retention':
        user, signup, active = column('user'), column('signup'), column('activity')
        require(p,'as_of')
        cutoff=date.fromisoformat(p['as_of']); width=integer(p.get('period_days',1),1,365); periods=integer(p.get('periods',7),1,60)
        population={}; events=defaultdict(set)
        for r in rows:
            if r[user] is None:
                raise ValueError('用户ID缺失')
            start=date.fromisoformat(r[signup])
            if start>cutoff or r[user] in population and population[r[user]] != start:
                raise ValueError('注册时间冲突或晚于观察日')
            population[r[user]]=start
            if r[active] is not None:
                day=date.fromisoformat(r[active])
                if day<start or day>cutoff:
                    raise ValueError('活动日期超出注册/观察范围')
                events[r[user]].add((day-start).days//width)
        for cohort in sorted(set(population.values())):
            members=[u for u,d in population.items() if d==cohort]
            for period in range(periods):
                mature=cohort+timedelta(days=(period+1)*width-1)<=cutoff
                retained=sum(period in events[u] for u in members) if mature else None
                output.append({'cohort':cohort.isoformat(),'period':period,'population':len(members),'mature':mature,'active':retained,'rate':retained/len(members) if mature else None})
        warnings.append('分母包含输入中的完整注册人口，包括活动日期为空的用户；调用方须保证输入人口完整。未成熟观察期返回空值。')
    elif method == 'funnel':
        user,event,time=column('user'),column('event'),column('time')
        require(p,'steps','window_seconds','as_of')
        steps=p['steps']; window=integer(p['window_seconds'],1,31536000); cutoff=utc(p['as_of'])
        if not isinstance(steps,list) or not 2<=len(steps)<=10 or len(set(steps))!=len(steps):
            raise ValueError('steps 需要2到10个不同事件名')
        events=defaultdict(list)
        for r in rows:
            if r[user] is None or r[event] is None: raise ValueError('用户ID或事件缺失')
            t=utc(r[time])
            if t>cutoff: raise ValueError('事件晚于观察截止时间')
            events[r[user]].append((t,r[event]))
        counts=[0]*len(steps); censored=0; ignored=0
        for seq in events.values():
            seq=sorted(set(seq)); entries=[t for t,e in seq if e==steps[0]]
            if not entries: ignored+=1; continue
            start=entries[0]
            if start+timedelta(seconds=window)>cutoff: censored+=1; continue
            counts[0]+=1; last=start
            for i,step in enumerate(steps[1:],1):
                candidates=[t for t,e in seq if e==step and last<t<=start+timedelta(seconds=window)]
                if not candidates: break
                last=min(candidates); counts[i]+=1
        output=[{'step':s,'users':counts[i],'conversionFromEntry':counts[i]/counts[0] if counts[0] else None} for i,s in enumerate(steps)]
        extra={'pendingWindowUsers':censored,'usersWithoutEntry':ignored,'ordering':'strict timestamp; equal timestamps do not establish order'}
    elif method == 'attribution':
        dimension,period,value=column('dimension'),column('period'),column('value');require(p,'before','after')
        if p['before']==p['after']:raise ValueError('比较时期必须不同')
        groups=defaultdict(lambda:[Decimal(0),Decimal(0)])
        selected=[r for r in rows if r[period] in (p['before'],p['after'])]
        if not all(any(r[period]==v for r in rows) for v in (p['before'],p['after'])):raise ValueError('缺少比较时期的数据')
        for r in selected:groups[r[dimension]][0 if r[period]==p['before'] else 1]+=number(r[value])
        for k,(a,b) in sorted(groups.items(),key=lambda kv:str(kv[0])):output.append({'segment':k,'before':str(a),'after':str(b),'contribution':str(b-a)})
        total=sum((number(r[value])*(1 if r[period]==p['after'] else -1) for r in selected),Decimal(0))
        checks.append({'name':'分组贡献与总体变化对账','passed':sum((number(r['contribution']) for r in output),Decimal(0))==total})
        extra={'totalChange':str(total),'excludedRows':len(rows)-len(selected)}
        warnings.append('仅支持可加总指标的组成贡献；不是因果归因。转化率须先核对分子/分母，不能把分组率直接相加。')
    elif method == 'ab':
        from scipy.stats import binomtest, fisher_exact
        user,group,outcome=column('user'),column('group'),column('outcome');require(p,'control','treatment')
        if p['control']==p['treatment'] or any(r[user] is None for r in rows) or len({r[user] for r in rows})!=len(rows):raise ValueError('要求每个随机化单位仅一行、非缺失，且实验组不同')
        if any(r[group] not in (p['control'],p['treatment']) or r[outcome] not in ('0','1') for r in rows):raise ValueError('仅支持两组、0/1二元结果；未知组或缺失结果不能静默排除')
        alpha=float(number(p.get('alpha',0.05))); allocation=float(number(p.get('expected_control',0.5))); comparisons=integer(p.get('comparisons',1),1,100)
        if not 0<alpha<1 or not 0<allocation<1:raise ValueError('alpha 和分流比例必须在0到1之间')
        groups=[[r for r in rows if r[group]==g] for g in (p['control'],p['treatment'])]; ns=[len(g) for g in groups]; ks=[sum(r[outcome]=='1' for r in g) for g in groups]
        if not all(ns):raise ValueError('实验两组均须非空')
        srm=binomtest(ns[0],sum(ns),allocation).pvalue
        raw=float(fisher_exact([[ks[0],ns[0]-ks[0]],[ks[1],ns[1]-ks[1]]]).pvalue); adjusted=min(1,raw*comparisons)
        intervals=[binomtest(k,n).proportion_ci(confidence_level=1-alpha/(2*comparisons)) for k,n in zip(ks,ns)]
        output=[{'group':g,'units':n,'conversions':k,'rate':k/n,'ciLow':ci.low,'ciHigh':ci.high} for g,n,k,ci in zip((p['control'],p['treatment']),ns,ks,intervals)]
        extra={'srmP':srm,'srmFlag':srm<0.01,'pValue':raw,'adjustedP':adjusted,'alpha':alpha,'comparisons':comparisons,'difference':ks[1]/ns[1]-ks[0]/ns[0], 'differenceCI':[intervals[1].low-intervals[0].high,intervals[1].high-intervals[0].low], 'relativeLift':(ks[1]/ns[1])/(ks[0]/ns[0])-1 if ks[0] else None,'significant':adjusted<alpha and srm>=0.01}
        warnings.append('Fisher双侧检验；Bonferroni多重比较；组率使用精确区间，差值区间为保守联合界。独立随机分流是前提，不能由数据自动证实；SRM异常时不宣布实验胜出。未显著不等于无效果。')
    elif method == 'series':
        time,value=column('date'),column('value'); holdout=integer(p.get('holdout',2),1,100); season=integer(p.get('season',1),1,365)
        points={}
        for r in rows:
            day=date.fromisoformat(r[time])
            if day in points:raise ValueError('同一天存在多行；请先明确聚合口径')
            points[day]=float(number(r[value]))
        if len(points)<holdout+max(season,3):raise ValueError('训练期不足，不能凭空生成预测评估')
        days=sorted(points); span=(days[-1]-days[0]).days+1
        if span>3660:raise ValueError('时间范围超过日粒度预算')
        calendar=[days[0]+timedelta(days=i) for i in range(span)]; missing=[d.isoformat() for d in calendar if d not in points]
        if missing:
            output=[{'date':d.isoformat(),'actual':points.get(d)} for d in calendar];extra={'missingDates':missing,'evaluation':None};warnings.append('缺期已标记为空，未填零或插值；补齐口径前不评估预测。')
        else:
            actual=[points[d] for d in days];train=actual[:-holdout];test=actual[-holdout:];pred=[train[-season+i%season] for i in range(holdout)]
            errors=[abs(a-b) for a,b in zip(test,pred)];denom=sum(abs(v) for v in test)
            med=statistics.median(train);mad=statistics.median(abs(v-med) for v in train)
            output=[{'date':d.isoformat(),'actual':v,'split':'train' if i<len(train) else 'holdout','prediction':None if i<len(train) else pred[i-len(train)],'anomaly':abs(v-med)>3*1.4826*mad if mad else v!=med} for i,(d,v) in enumerate(zip(days,actual))]
            extra={'trainingRows':len(train),'holdoutRows':holdout,'season':season,'mae':sum(errors)/holdout,'wape':sum(errors)/denom if denom else None,'trendPerDay':statistics.linear_regression(range(len(train)),train).slope,'baseline':'fixed seasonal-naive; period chosen before evaluation'}
            warnings.append('仅日粒度固定季节朴素基线；训练期拟合趋势与异常阈值，按时间留出评估；不以评估集调参，不输出无依据因果解释。零分母 WAPE 返回空值，不使用 MAPE。')
    else:
        raise ValueError('未发布的方法：'+str(method))
    if len(output)>10000:raise ValueError('分析结果超过行预算')
    if any(not c['passed'] for c in checks):raise ValueError('分析校验失败')
    return {'method':method,'methodVersion':1,'table':output,'summary':extra,'checks':checks,'warnings':warnings,'inputRows':len(rows)}
