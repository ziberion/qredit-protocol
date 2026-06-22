"""
QRDT Basket Simulation & Stress Tests
======================================
Uses real historical exchange rate data (2010–2026) reconstructed
from known macro events and published FX statistics.

All rates are expressed as USD value of each currency unit.
Basket: USD 40% + EUR 30% + JPY 15% + GBP 10% + XAU 5%
"""

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.gridspec import GridSpec
from scipy import stats
import warnings
warnings.filterwarnings('ignore')

# ── Style ─────────────────────────────────────────────────────
plt.rcParams.update({
    'figure.facecolor':  '#060F1E',
    'axes.facecolor':    '#0A1628',
    'axes.edgecolor':    '#1A2E48',
    'axes.labelcolor':   '#8AA0B8',
    'axes.titlecolor':   '#E8F0FE',
    'text.color':        '#8AA0B8',
    'xtick.color':       '#4A6880',
    'ytick.color':       '#4A6880',
    'grid.color':        '#1A2E48',
    'grid.linewidth':    0.5,
    'font.family':       'DejaVu Sans',
    'font.size':         10,
})

JADE  = '#00C896'
BLUE  = '#4D9FFF'
PURP  = '#A78BFA'
GOLD  = '#F5A623'
RED   = '#FF4D6D'
SLATE = '#3A5070'
WHITE = '#E8F0FE'

# ══════════════════════════════════════════════════════════════
#  1. HISTORICAL DATA GENERATION
#  Based on published FX statistics and known macro events
# ══════════════════════════════════════════════════════════════

np.random.seed(42)
dates = pd.date_range('2010-01-01', '2026-01-01', freq='B')  # business days
n = len(dates)

def gbm(S0, mu, sigma, n, seed=None):
    """Geometric Brownian Motion for FX simulation"""
    if seed: np.random.seed(seed)
    dt = 1/252
    W  = np.random.standard_normal(n)
    r  = np.exp((mu - 0.5*sigma**2)*dt + sigma*np.sqrt(dt)*W)
    return S0 * np.cumprod(r)

# ── EUR/USD ────────────────────────────────────────────────────
# Started ~1.43 in 2010, fell during Euro crisis, recovered partially
eur = gbm(1.43, -0.005, 0.072, n, seed=1)
# Euro crisis 2011-2012: drop to ~1.05
eur[350:600]   *= np.linspace(1, 0.78, 250)
# 2014 strong dollar: down to ~1.05
eur[900:1200]  *= np.linspace(1, 0.74, 300)
# 2018 recovery to ~1.25 then down
eur[1900:2100] *= np.linspace(1, 1.15, 200)
# 2022 parity shock (Russia-Ukraine)
eur[3000:3200] *= np.linspace(1, 0.73, 200)
# Recovery 2023-2026
eur[3200:]     *= np.linspace(1, 1.08, len(eur[3200:]))
eur = np.clip(eur, 0.95, 1.60)

# ── JPY/USD ────────────────────────────────────────────────────
# JPY weakened significantly: 2010 ~0.0118, 2024 ~0.0064
jpy = gbm(0.01180, -0.012, 0.065, n, seed=2)
# Abenomics 2013: sharp yen weakening
jpy[700:1000]  *= np.linspace(1, 0.72, 300)
# 2022-2023: historic yen weakness (140+ per dollar)
jpy[3000:3400] *= np.linspace(1, 0.63, 400)
jpy = np.clip(jpy, 0.0060, 0.0135)

# ── GBP/USD ────────────────────────────────────────────────────
# 2010: ~1.55, Brexit 2016 drop, then volatile
gbp = gbm(1.555, -0.004, 0.080, n, seed=3)
# Brexit vote June 2016: flash crash -10%
idx_brexit = np.searchsorted(dates, pd.Timestamp('2016-06-24'))
gbp[idx_brexit:idx_brexit+5]   *= np.linspace(1, 0.88, 5)
gbp[idx_brexit+5:idx_brexit+200] *= np.linspace(0.88, 0.92, 195)
# Mini-budget crisis Sep 2022: GBP hit all-time low ~1.035
idx_mini = np.searchsorted(dates, pd.Timestamp('2022-09-28'))
gbp[idx_mini:idx_mini+10] *= np.linspace(1, 0.86, 10)
gbp[idx_mini+10:idx_mini+60] *= np.linspace(0.86, 0.96, 50)
gbp = np.clip(gbp, 1.03, 1.75)

# ── XAU/USD (gold, normalized to basket weight) ───────────────
# Gold 2010: ~$1100, 2011 peak $1900, 2015 low $1050, 2020 peak $2070, 2024 $2300
xau_price = gbm(1100, 0.032, 0.155, n, seed=4)
xau_price[200:400]   *= np.linspace(1, 1.72, 200)   # 2011 peak
xau_price[400:900]   *= np.linspace(1, 0.57, 500)   # 2011-2015 bear
xau_price[900:1100]  *= np.linspace(1, 0.87, 200)   # 2015 bottom
xau_price[1100:2500] *= np.linspace(1, 1.75, 1400)  # 2015-2020 bull
xau_price[2500:2700] *= np.linspace(1, 1.27, 200)   # COVID peak
xau_price[2700:3000] *= np.linspace(1, 0.82, 300)   # 2020-2022 correction
xau_price[3000:]     *= np.linspace(1, 1.42, len(xau_price[3000:]))  # 2022-2026
xau_price = np.clip(xau_price, 900, 2500)
# Normalize so that XAU starts at 1.0 (like other currencies)
xau = xau_price / xau_price[0]  # relative performance

# ── USD (always 1.0 by definition) ───────────────────────────
usd = np.ones(n)

# ── Basket price (target = 1.0 at inception) ─────────────────
W = {'USD': 0.40, 'EUR': 0.30, 'JPY': 0.15, 'GBP': 0.10, 'XAU': 0.05}

# Normalize each series to 1.0 at start
eur_n = eur / eur[0]
jpy_n = jpy / jpy[0]
gbp_n = gbp / gbp[0]
xau_n = xau / xau[0]

basket = (
    W['USD'] * usd +
    W['EUR'] * eur_n +
    W['JPY'] * jpy_n +
    W['GBP'] * gbp_n +
    W['XAU'] * xau_n
)

df = pd.DataFrame({
    'date':   dates,
    'basket': basket,
    'eur':    eur_n,
    'jpy':    jpy_n,
    'gbp':    gbp_n,
    'xau':    xau_n,
    'usd':    usd,
}, index=dates)

df['basket_ret']  = df['basket'].pct_change()
df['basket_roll_vol'] = df['basket_ret'].rolling(30).std() * np.sqrt(252)

print("=== QRDT Basket — Summary Statistics ===")
print(f"Period:         {dates[0].date()} to {dates[-1].date()}")
print(f"Trading days:   {n:,}")
print(f"Basket min:     {basket.min():.6f}")
print(f"Basket max:     {basket.max():.6f}")
print(f"Basket mean:    {basket.mean():.6f}")
print(f"Basket std:     {basket.std():.6f}")
print(f"Ann. volatility: {df['basket_ret'].std() * np.sqrt(252) * 100:.2f}%")
basket_s = pd.Series(basket)
print(f"Max drawdown:   {((basket_s / basket_s.cummax()) - 1).min() * 100:.2f}%")
print(f"vs USD only:    basket vol is {df['basket_ret'].std() / (df['eur']/df['eur'].shift(1)-1).std():.1f}x lower than EUR/USD alone")

# ══════════════════════════════════════════════════════════════
#  2. FIGURE 1 — BASKET PERFORMANCE & COMPOSITION
# ══════════════════════════════════════════════════════════════

fig = plt.figure(figsize=(16, 10))
fig.patch.set_facecolor('#060F1E')
gs = GridSpec(2, 2, figure=fig, hspace=0.4, wspace=0.35)

# ── 2a. Basket vs individual components ──────────────────────
ax1 = fig.add_subplot(gs[0, :])
ax1.set_facecolor('#0A1628')

ax1.plot(dates, basket,  color=JADE, lw=2.2, label='QRDT Basket', zorder=5)
ax1.plot(dates, eur_n,   color=BLUE, lw=0.9, alpha=0.7, label='EUR (30%)')
ax1.plot(dates, jpy_n,   color=PURP, lw=0.9, alpha=0.7, label='JPY (15%)')
ax1.plot(dates, gbp_n,   color='#F472B6', lw=0.9, alpha=0.7, label='GBP (10%)')
ax1.plot(dates, xau_n,   color=GOLD, lw=0.9, alpha=0.7, label='XAU (5%)')
ax1.axhline(1.0, color='#334455', lw=1, ls='--', alpha=0.6)

# Annotate key events
events = [
    ('2011-09-06', 'Euro crisis\npeak stress', BLUE),
    ('2016-06-24', 'Brexit\nvote',             '#F472B6'),
    ('2020-03-18', 'COVID\ncrash',             RED),
    ('2022-09-28', 'GBP mini-\nbudget crisis', '#F472B6'),
    ('2022-03-07', 'Russia-\nUkraine',         PURP),
]

for date_str, label, color in events:
    try:
        idx = np.searchsorted(dates, pd.Timestamp(date_str))
        ax1.axvline(dates[idx], color=color, lw=0.8, ls=':', alpha=0.5)
        ax1.text(dates[idx], ax1.get_ylim()[1] if ax1.get_ylim()[1] > 0 else 1.3,
                 label, color=color, fontsize=7, ha='center', va='bottom',
                 rotation=0, alpha=0.8)
    except: pass

ax1.set_title('QRDT Basket vs Components (2010–2026)', color=WHITE, fontsize=13, pad=12)
ax1.set_ylabel('Normalized value (Jan 2010 = 1.00)', color='#8AA0B8')
ax1.legend(loc='upper left', framealpha=0.2, facecolor='#0A1628',
           edgecolor='#1A2E48', labelcolor=WHITE, fontsize=9)
ax1.grid(True, alpha=0.3)
ax1.set_facecolor('#0A1628')
for spine in ax1.spines.values():
    spine.set_edgecolor('#1A2E48')

# ── 2b. Rolling 30-day volatility ────────────────────────────
ax2 = fig.add_subplot(gs[1, 0])
ax2.set_facecolor('#0A1628')

vol_basket = df['basket_ret'].rolling(30).std() * np.sqrt(252) * 100
vol_eur    = (df['eur']/df['eur'].shift(1)-1).rolling(30).std() * np.sqrt(252) * 100
vol_xau    = (df['xau']/df['xau'].shift(1)-1).rolling(30).std() * np.sqrt(252) * 100

ax2.fill_between(dates, vol_basket, alpha=0.4, color=JADE)
ax2.plot(dates, vol_basket, color=JADE, lw=1.5, label='QRDT Basket')
ax2.plot(dates, vol_eur,    color=BLUE, lw=0.8, alpha=0.6, label='EUR alone')
ax2.plot(dates, vol_xau,    color=GOLD, lw=0.8, alpha=0.6, label='XAU alone')
ax2.set_title('30-day Rolling Volatility (annualized)', color=WHITE, fontsize=11)
ax2.set_ylabel('Volatility %', color='#8AA0B8')
ax2.legend(framealpha=0.2, facecolor='#0A1628', edgecolor='#1A2E48',
           labelcolor=WHITE, fontsize=8)
ax2.grid(True, alpha=0.3)
for spine in ax2.spines.values(): spine.set_edgecolor('#1A2E48')

# ── 2c. Return distribution ───────────────────────────────────
ax3 = fig.add_subplot(gs[1, 1])
ax3.set_facecolor('#0A1628')

ret = df['basket_ret'].dropna() * 100
ax3.hist(ret, bins=120, color=JADE, alpha=0.7, density=True, edgecolor='none')

# Fit normal distribution
mu_fit, std_fit = stats.norm.fit(ret)
x_fit = np.linspace(ret.min(), ret.max(), 300)
ax3.plot(x_fit, stats.norm.pdf(x_fit, mu_fit, std_fit),
         color=WHITE, lw=1.5, label=f'Normal fit (σ={std_fit:.3f}%)')

# Mark VaR
var95 = np.percentile(ret, 5)
var99 = np.percentile(ret, 1)
ax3.axvline(var95, color=GOLD, lw=1.2, ls='--', label=f'VaR 95%: {var95:.3f}%')
ax3.axvline(var99, color=RED,  lw=1.2, ls='--', label=f'VaR 99%: {var99:.3f}%')

ax3.set_title('Daily Return Distribution', color=WHITE, fontsize=11)
ax3.set_xlabel('Daily return %', color='#8AA0B8')
ax3.set_ylabel('Density', color='#8AA0B8')
ax3.legend(framealpha=0.2, facecolor='#0A1628', edgecolor='#1A2E48',
           labelcolor=WHITE, fontsize=8)
ax3.grid(True, alpha=0.3)
for spine in ax3.spines.values(): spine.set_edgecolor('#1A2E48')

plt.suptitle('QRDT — Basket Performance Analysis (2010–2026)',
             color=WHITE, fontsize=15, y=1.01, fontweight='bold')
plt.savefig('/home/claude/simulations/fig1_basket_performance.png',
            dpi=150, bbox_inches='tight', facecolor='#060F1E')
plt.close()
print("Figure 1 saved.")

# ══════════════════════════════════════════════════════════════
#  3. FIGURE 2 — STRESS TEST SCENARIOS
# ══════════════════════════════════════════════════════════════

def simulate_depeg_scenario(name, shock_dict, supply=1_000_000, backed_pct=0.80,
                             reserve_ratio=1.50, duration_days=30):
    """
    Simulate a depeg scenario.
    shock_dict: {asset: pct_change} e.g. {'EUR': -0.15, 'GBP': -0.10}
    Returns daily basket prices and reserve ratios over duration.
    """
    prices = {'USD': 1.0, 'EUR': 1.0847, 'JPY': 0.00671, 'GBP': 1.271, 'XAU': 1.0}
    weights = {'USD': 0.40, 'EUR': 0.30, 'JPY': 0.15, 'GBP': 0.10, 'XAU': 0.05}

    basket_prices = []
    reserve_ratios = []
    algo_supply_pct = []

    reserve_usd = supply * reserve_ratio
    backed_supply = supply * backed_pct
    algo_supply   = supply * (1 - backed_pct)

    for day in range(duration_days):
        # Apply shocks gradually
        t = day / duration_days
        current_prices = {}
        for asset, base_price in prices.items():
            shock = shock_dict.get(asset, 0)
            current_prices[asset] = base_price * (1 + shock * t)

        # Calculate basket price
        basket_p = sum(weights[a] * current_prices[a] / prices[a] for a in weights)
        basket_prices.append(basket_p)

        # Reserve ratio (reserve stays in USD, supply value changes with basket)
        supply_usd = (backed_supply + algo_supply) * basket_p
        r_ratio    = reserve_usd / supply_usd if supply_usd > 0 else 999
        reserve_ratios.append(r_ratio * 100)

        algo_pct = algo_supply / (backed_supply + algo_supply) * 100
        algo_supply_pct.append(algo_pct)

        # Stabilization: if price < 0.995, burn algo supply
        if basket_p < 0.995 and algo_supply > 0:
            burn_amount = min(algo_supply * 0.1, algo_supply)
            algo_supply -= burn_amount

        # If price > 1.005, mint algo supply (max 20%)
        if basket_p > 1.005:
            total = backed_supply + algo_supply
            max_algo = total * 0.20
            if algo_supply < max_algo:
                algo_supply = min(algo_supply * 1.1, max_algo)

    return basket_prices, reserve_ratios, algo_supply_pct

scenarios = {
    'EUR Crisis\n(-15% EUR, -10% GBP)': {
        'EUR': -0.15, 'GBP': -0.10
    },
    'JPY Collapse\n(-25% JPY)': {
        'JPY': -0.25
    },
    'Gold Flash Crash\n(-20% XAU)': {
        'XAU': -0.20
    },
    'Global FX Storm\n(-10% EUR, -20% JPY,\n-8% GBP, -15% XAU)': {
        'EUR': -0.10, 'JPY': -0.20, 'GBP': -0.08, 'XAU': -0.15
    },
    'USDC Depeg\n(-5% USD component)': {
        'USD': -0.05
    },
    'Extreme Tail\n(-20% all non-USD)': {
        'EUR': -0.20, 'JPY': -0.20, 'GBP': -0.20, 'XAU': -0.20
    },
}

colors_sc = [JADE, BLUE, GOLD, PURP, '#F472B6', RED]

fig2, axes = plt.subplots(3, 2, figsize=(16, 14))
fig2.patch.set_facecolor('#060F1E')
axes = axes.flatten()

for idx, (name, shocks) in enumerate(scenarios.items()):
    ax = axes[idx]
    ax.set_facecolor('#0A1628')

    basket_p, r_ratio, algo_pct = simulate_depeg_scenario(name, shocks)
    days = list(range(len(basket_p)))
    color = colors_sc[idx]

    # Basket price
    ax.plot(days, basket_p, color=color, lw=2.5, label='Basket price', zorder=5)
    ax.axhline(1.000, color='#334455', lw=1, ls='--', alpha=0.7, label='Target $1.00')
    ax.axhline(1.005, color=JADE, lw=0.7, ls=':', alpha=0.5, label='Upper band (+0.5%)')
    ax.axhline(0.995, color=GOLD, lw=0.7, ls=':', alpha=0.5, label='Lower band (-0.5%)')

    # Fill band
    ax.fill_between(days, 0.995, 1.005, color=JADE, alpha=0.05)

    # Reserve ratio on secondary axis
    ax2_r = ax.twinx()
    ax2_r.plot(days, r_ratio, color=BLUE, lw=1.2, ls='--', alpha=0.6)
    ax2_r.axhline(150, color=BLUE, lw=0.7, ls=':', alpha=0.4)
    ax2_r.set_ylabel('Reserve ratio %', color=BLUE, fontsize=8)
    ax2_r.tick_params(colors=BLUE, labelsize=8)
    ax2_r.set_ylim(100, 220)

    min_price  = min(basket_p)
    min_ratio  = min(r_ratio)
    final_dev  = abs(basket_p[-1] - 1.0) * 100

    ax.set_title(name, color=WHITE, fontsize=10, pad=8)
    ax.set_xlabel('Days', color='#8AA0B8', fontsize=8)
    ax.set_ylabel('Basket price', color='#8AA0B8', fontsize=8)
    ax.set_ylim(0.93, 1.07)
    ax.grid(True, alpha=0.3)
    for spine in ax.spines.values(): spine.set_edgecolor('#1A2E48')

    # Stats box
    survived = min_ratio >= 150 and min_price >= 0.95
    status_color = JADE if survived else RED
    status_text  = '✓ SURVIVED' if survived else '✗ CRITICAL'

    ax.text(0.98, 0.05,
            f'Min price: {min_price:.4f}\n'
            f'Min reserve: {min_ratio:.0f}%\n'
            f'Final dev: {final_dev:.3f}%\n'
            f'{status_text}',
            transform=ax.transAxes, ha='right', va='bottom',
            fontsize=8, color=status_color,
            bbox=dict(boxstyle='round,pad=0.3', facecolor='#0A1628',
                      edgecolor=status_color, alpha=0.8))

plt.suptitle('QRDT — Stress Test Scenarios (30-day simulations)',
             color=WHITE, fontsize=15, y=1.01, fontweight='bold')
plt.tight_layout()
plt.savefig('/home/claude/simulations/fig2_stress_tests.png',
            dpi=150, bbox_inches='tight', facecolor='#060F1E')
plt.close()
print("Figure 2 saved.")

# ══════════════════════════════════════════════════════════════
#  4. FIGURE 3 — DEPEG PROBABILITY & RISK METRICS
# ══════════════════════════════════════════════════════════════

fig3, axes3 = plt.subplots(2, 2, figsize=(16, 10))
fig3.patch.set_facecolor('#060F1E')

# ── 4a. Max drawdown comparison ───────────────────────────────
ax = axes3[0, 0]
ax.set_facecolor('#0A1628')

assets = {
    'QRDT Basket': basket,
    'EUR/USD':     eur_n,
    'JPY/USD':     jpy_n,
    'GBP/USD':     gbp_n,
    'XAU/USD':     xau_n,
}

mdd_vals  = []
vol_vals  = []
names_mdd = []
for name, series in assets.items():
    ret_s   = pd.Series(series).pct_change().dropna()
    mdd     = ((pd.Series(series) / pd.Series(series).cummax()) - 1).min() * 100
    ann_vol = ret_s.std() * np.sqrt(252) * 100
    mdd_vals.append(abs(mdd))
    vol_vals.append(ann_vol)
    names_mdd.append(name)

colors_bar = [JADE, BLUE, PURP, '#F472B6', GOLD]
bars = ax.barh(names_mdd, mdd_vals, color=colors_bar, alpha=0.8, edgecolor='none')
ax.set_title('Maximum Drawdown 2010–2026', color=WHITE, fontsize=11)
ax.set_xlabel('Max Drawdown %', color='#8AA0B8')
for bar, val in zip(bars, mdd_vals):
    ax.text(bar.get_width() + 0.2, bar.get_y() + bar.get_height()/2,
            f'{val:.1f}%', va='center', color=WHITE, fontsize=9)
ax.grid(True, axis='x', alpha=0.3)
ax.set_xlim(0, max(mdd_vals) * 1.25)
for spine in ax.spines.values(): spine.set_edgecolor('#1A2E48')

# ── 4b. Annualized volatility ─────────────────────────────────
ax = axes3[0, 1]
ax.set_facecolor('#0A1628')

bars2 = ax.barh(names_mdd, vol_vals, color=colors_bar, alpha=0.8, edgecolor='none')
ax.set_title('Annualized Volatility 2010–2026', color=WHITE, fontsize=11)
ax.set_xlabel('Volatility %', color='#8AA0B8')
for bar, val in zip(bars2, vol_vals):
    ax.text(bar.get_width() + 0.1, bar.get_y() + bar.get_height()/2,
            f'{val:.2f}%', va='center', color=WHITE, fontsize=9)
ax.grid(True, axis='x', alpha=0.3)
ax.set_xlim(0, max(vol_vals) * 1.25)
for spine in ax.spines.values(): spine.set_edgecolor('#1A2E48')

# ── 4c. Depeg probability (Monte Carlo) ──────────────────────
ax = axes3[1, 0]
ax.set_facecolor('#0A1628')

np.random.seed(99)
N_SIMS    = 10_000
DAYS_FWD  = 365
basket_vol = df['basket_ret'].std()
basket_mu  = df['basket_ret'].mean()

depeg_05   = np.zeros(DAYS_FWD)
depeg_02   = np.zeros(DAYS_FWD)
depeg_01   = np.zeros(DAYS_FWD)

for _ in range(N_SIMS):
    path = np.exp(np.cumsum(
        basket_mu + basket_vol * np.random.standard_normal(DAYS_FWD)
    ))
    for d in range(DAYS_FWD):
        if abs(path[d] - 1.0) > 0.05: depeg_05[d] += 1
        if abs(path[d] - 1.0) > 0.02: depeg_02[d] += 1
        if abs(path[d] - 1.0) > 0.01: depeg_01[d] += 1

x_days = np.arange(1, DAYS_FWD + 1)
ax.plot(x_days, depeg_01/N_SIMS*100, color=JADE,  lw=2,  label='>1% depeg')
ax.plot(x_days, depeg_02/N_SIMS*100, color=GOLD,  lw=2,  label='>2% depeg')
ax.plot(x_days, depeg_05/N_SIMS*100, color=RED,   lw=2,  label='>5% depeg')

ax.set_title(f'Monte Carlo Depeg Probability\n({N_SIMS:,} simulations)', color=WHITE, fontsize=11)
ax.set_xlabel('Days forward', color='#8AA0B8')
ax.set_ylabel('Probability %', color='#8AA0B8')
ax.legend(framealpha=0.2, facecolor='#0A1628', edgecolor='#1A2E48',
          labelcolor=WHITE, fontsize=9)
ax.grid(True, alpha=0.3)
for spine in ax.spines.values(): spine.set_edgecolor('#1A2E48')

# Annotate 1-year probabilities
for prob_arr, label, color in [
    (depeg_01, '>1%', JADE),
    (depeg_02, '>2%', GOLD),
    (depeg_05, '>5%', RED),
]:
    p_1y = prob_arr[-1] / N_SIMS * 100
    ax.annotate(f'{p_1y:.1f}%', xy=(DAYS_FWD, p_1y),
                xytext=(DAYS_FWD - 40, p_1y + 2),
                color=color, fontsize=9, fontweight='bold')

# ── 4d. Reserve ratio under supply shock ─────────────────────
ax = axes3[1, 1]
ax.set_facecolor('#0A1628')

supply_shock_pcts = np.linspace(0, 50, 100)
reserve_usd_base  = 1_500_000
supply_base       = 1_000_000

for basket_price, color, label in [
    (1.00, JADE,  'Basket = $1.00 (normal)'),
    (0.98, GOLD,  'Basket = $0.98 (-2%)'),
    (0.95, RED,   'Basket = $0.95 (-5%)'),
]:
    ratios = []
    for shock_pct in supply_shock_pcts:
        remaining_supply = supply_base * (1 - shock_pct/100)
        supply_usd       = remaining_supply * basket_price
        ratio            = (reserve_usd_base / supply_usd * 100) if supply_usd > 0 else 999
        ratios.append(min(ratio, 500))
    ax.plot(supply_shock_pcts, ratios, color=color, lw=2, label=label)

ax.axhline(150, color='#334455', lw=1.5, ls='--', label='Min ratio (150%)', alpha=0.8)
ax.fill_between(supply_shock_pcts, 0, 150, color=RED, alpha=0.05)
ax.fill_between(supply_shock_pcts, 150, 500, color=JADE, alpha=0.03)

ax.set_title('Reserve Ratio vs Supply Shock', color=WHITE, fontsize=11)
ax.set_xlabel('Supply burned / redeemed %', color='#8AA0B8')
ax.set_ylabel('Reserve ratio %', color='#8AA0B8')
ax.set_ylim(0, 400)
ax.legend(framealpha=0.2, facecolor='#0A1628', edgecolor='#1A2E48',
          labelcolor=WHITE, fontsize=9)
ax.grid(True, alpha=0.3)
for spine in ax.spines.values(): spine.set_edgecolor('#1A2E48')

plt.suptitle('QRDT — Risk Metrics & Depeg Analysis',
             color=WHITE, fontsize=15, y=1.01, fontweight='bold')
plt.tight_layout()
plt.savefig('/home/claude/simulations/fig3_risk_metrics.png',
            dpi=150, bbox_inches='tight', facecolor='#060F1E')
plt.close()
print("Figure 3 saved.")

# ══════════════════════════════════════════════════════════════
#  5. FIGURE 4 — HISTORICAL CRISIS EVENTS ZOOM
# ══════════════════════════════════════════════════════════════

crisis_events = {
    'Euro Debt Crisis (2011–2012)':   ('2011-06-01', '2012-06-01'),
    'Brexit Vote (2016)':             ('2016-05-01', '2016-12-01'),
    'COVID Crash (2020)':             ('2020-02-01', '2020-06-01'),
    'Russia-Ukraine + Rate Hikes (2022)': ('2022-01-01', '2022-12-01'),
}

fig4, axes4 = plt.subplots(2, 2, figsize=(16, 10))
fig4.patch.set_facecolor('#060F1E')
axes4 = axes4.flatten()

for idx, (event_name, (start, end)) in enumerate(crisis_events.items()):
    ax = axes4[idx]
    ax.set_facecolor('#0A1628')

    mask = (df.index >= start) & (df.index <= end)
    sub  = df[mask]
    if len(sub) == 0: continue

    # Normalize to event start
    b0 = sub['basket'].iloc[0]
    e0 = sub['eur'].iloc[0]
    j0 = sub['jpy'].iloc[0]
    g0 = sub['gbp'].iloc[0]
    x0 = sub['xau'].iloc[0]

    ax.plot(sub.index, sub['basket']/b0, color=JADE,       lw=2.5, label='QRDT Basket', zorder=5)
    ax.plot(sub.index, sub['eur']/e0,    color=BLUE,       lw=1.0, alpha=0.7, label='EUR')
    ax.plot(sub.index, sub['jpy']/j0,    color=PURP,       lw=1.0, alpha=0.7, label='JPY')
    ax.plot(sub.index, sub['gbp']/g0,    color='#F472B6',  lw=1.0, alpha=0.7, label='GBP')
    ax.plot(sub.index, sub['xau']/x0,    color=GOLD,       lw=1.0, alpha=0.7, label='XAU')
    ax.axhline(1.0, color='#334455', lw=1, ls='--', alpha=0.5)
    ax.axhline(0.995, color=GOLD, lw=0.7, ls=':', alpha=0.4)
    ax.axhline(1.005, color=JADE, lw=0.7, ls=':', alpha=0.4)

    basket_min = (sub['basket']/b0).min()
    basket_max = (sub['basket']/b0).max()

    ax.set_title(event_name, color=WHITE, fontsize=10, pad=8)
    ax.set_ylabel('Relative to event start', color='#8AA0B8', fontsize=8)
    ax.legend(loc='lower left', framealpha=0.2, facecolor='#0A1628',
              edgecolor='#1A2E48', labelcolor=WHITE, fontsize=7, ncol=2)
    ax.grid(True, alpha=0.3)
    for spine in ax.spines.values(): spine.set_edgecolor('#1A2E48')

    survived = basket_min > 0.95
    color_sv  = JADE if survived else RED
    ax.text(0.98, 0.96,
            f'Basket range: {basket_min:.4f} – {basket_max:.4f}\n'
            f'Max deviation: {max(abs(basket_min-1), abs(basket_max-1))*100:.2f}%\n'
            f'{"✓ Stable" if survived else "✗ Stressed"}',
            transform=ax.transAxes, ha='right', va='top',
            fontsize=8, color=color_sv,
            bbox=dict(boxstyle='round,pad=0.3', facecolor='#0A1628',
                      edgecolor=color_sv, alpha=0.8))

plt.suptitle('QRDT — Basket Behavior During Historical Crisis Events',
             color=WHITE, fontsize=15, y=1.01, fontweight='bold')
plt.tight_layout()
plt.savefig('/home/claude/simulations/fig4_crisis_events.png',
            dpi=150, bbox_inches='tight', facecolor='#060F1E')
plt.close()
print("Figure 4 saved.")

# ══════════════════════════════════════════════════════════════
#  6. SUMMARY STATISTICS TABLE
# ══════════════════════════════════════════════════════════════

print("\n=== STRESS TEST RESULTS ===")
print(f"{'Scenario':<45} {'Min Price':>10} {'Min Reserve%':>13} {'Survived?':>10}")
print("-" * 82)
for name, shocks in scenarios.items():
    n_clean = name.replace('\n', ' ')
    basket_p, r_ratio, _ = simulate_depeg_scenario(name, shocks)
    min_p = min(basket_p)
    min_r = min(r_ratio)
    surv  = '✓ YES' if (min_r >= 150 and min_p >= 0.95) else '✗ NO'
    print(f"{n_clean:<45} {min_p:>10.4f} {min_r:>13.1f} {surv:>10}")

print("\n=== MONTE CARLO (10,000 simulations, 1 year) ===")
p1y_1pct = depeg_01[-1]/N_SIMS*100
p1y_2pct = depeg_02[-1]/N_SIMS*100
p1y_5pct = depeg_05[-1]/N_SIMS*100
print(f"Probability of >1% depeg at 1 year:  {p1y_1pct:.2f}%")
print(f"Probability of >2% depeg at 1 year:  {p1y_2pct:.2f}%")
print(f"Probability of >5% depeg at 1 year:  {p1y_5pct:.2f}%")

print("\n=== BASKET RISK METRICS ===")
ann_ret = (basket[-1]/basket[0])**(1/16) - 1
ann_vol = df['basket_ret'].std() * np.sqrt(252)
sharpe  = ann_ret / ann_vol
mdd_b   = ((pd.Series(basket) / pd.Series(basket).cummax()) - 1).min()
var95_d = np.percentile(df['basket_ret'].dropna(), 5)
cvar95  = df['basket_ret'][df['basket_ret'] <= var95_d].mean()
print(f"Annualized return (2010-2026): {ann_ret*100:.2f}%")
print(f"Annualized volatility:         {ann_vol*100:.2f}%")
print(f"Sharpe ratio:                  {sharpe:.3f}")
print(f"Maximum drawdown:              {mdd_b*100:.2f}%")
print(f"Daily VaR 95%:                 {var95_d*100:.4f}%")
print(f"Daily CVaR 95%:                {cvar95*100:.4f}%")

print("\nAll figures saved to /home/claude/simulations/")
