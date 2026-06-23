// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// ============================================================
//  Qredit (QRDT) v1.0
//  qredits.io · github.com/ziberion/qredit-protocol
//
//  A neutral global exchange currency anchored to a basket
//  of five international currencies:
//  40% USD · 30% EUR · 15% JPY · 10% GBP · 5% XAU
//
//  Hybrid stabilization: ≥80% real-asset backed + ≤20% algorithmic
//
//  FIX PRE-01: ERC20Votes added for snapshot-based voting power
//              (flash loan attack protection)
// ============================================================

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Minimal interface for the basket price oracle
interface IBasketOracle {
    function getPrice()
        external
        view
        returns (uint256 price, bool valid, uint256 timestamp);
}

/// @title  Qredit
/// @notice ERC-20 global exchange currency for the Qredit protocol
/// @dev    All monetary values use 18 decimals (standard ERC-20).
///         Oracle prices use 8 decimals (Chainlink standard).
///         Reserve USD values use 8 decimals.
///         ERC20Votes enables snapshot-based voting power for governance.
contract Qredit is ERC20Votes, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Roles ─────────────────────────────────────────────────
    bytes32 public constant MINTER_ROLE     = keccak256("MINTER_ROLE");
    bytes32 public constant STABILIZER_ROLE = keccak256("STABILIZER_ROLE");
    bytes32 public constant RESERVE_ROLE    = keccak256("RESERVE_ROLE");
    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");

    // ── Protocol constants ────────────────────────────────────
    uint256 public constant PRECISION          = 1e8;
    uint256 public constant TARGET_PRICE       = 1e8;
    uint256 public constant STABILITY_BAND     = 500_000;
    uint256 public constant MIN_RESERVE_RATIO  = 150 * 1e8 / 100;
    uint256 public constant MAX_ALGO_RATIO     = 20  * 1e8 / 100;
    uint256 public constant MAX_MINT_PER_TX    = 1_000_000 * 1e18;
    uint256 public constant MAX_RESERVE_ASSETS = 20;
    uint256 public constant ORACLE_TIMEOUT     = 2 hours;
    uint256 public constant STABILIZE_COOLDOWN = 15 minutes;
    uint256 public constant MAX_TRANSFER_FEE   = 100;

    // ── Metadata ──────────────────────────────────────────────
    string public constant VERSION = "2.0.0";
    string public constant WEBSITE = "qredits.io";

    // ── Oracle ────────────────────────────────────────────────
    IBasketOracle public oracle;
    uint256 public lastOraclePrice;
    uint256 public lastOracleUpdate;

    // ── Supply tracking ───────────────────────────────────────
    uint256 public backedSupply;
    uint256 public algorithmicSupply;

    // ── Reserve assets ────────────────────────────────────────
    struct ReserveAsset {
        address token;
        string  symbol;
        uint256 balance;
        uint256 priceUSD8;
        uint256 lastPriceUpdate;
        bool    active;
        bool    isStable;
    }

    mapping(address => ReserveAsset) public reserveAssets;
    address[] public reserveAssetList;
    uint256 public totalReserveUSD8;

    // ── Stabilizer state ──────────────────────────────────────
    uint256 public lastStabilizeTime;

    // ── Transfer fee ──────────────────────────────────────────
    uint256 public transferFeeBps;
    address public feeRecipient;
    mapping(address => bool) public feeExempt;

    // ── Events ────────────────────────────────────────────────
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event PriceRefreshed(uint256 price, bool valid);
    event MintBacked(address indexed to, uint256 amount, uint256 reserveRatio);
    event MintAlgorithmic(address indexed to, uint256 amount, uint256 algoRatio);
    event Burned(address indexed from, uint256 amount);
    event ReserveAssetAdded(address indexed token, string symbol);
    event ReserveAssetDeactivated(address indexed token);
    event ReserveDeposited(address indexed token, uint256 amount, uint256 usdValue8);
    event ReserveWithdrawn(address indexed token, uint256 amount);
    event ReservePriceUpdated(address indexed token, uint256 priceUSD8);
    event TotalReserveUpdated(uint256 totalUSD8);
    event Stabilized(string action, uint256 amount, uint256 price);
    event FeeUpdated(uint256 feeBps, address recipient);
    event FeeExemptUpdated(address account, bool exempt);

    // ── Modifiers ─────────────────────────────────────────────
    modifier oracleValid() {
        (, bool valid, ) = oracle.getPrice();
        require(valid, "Oracle: price not valid");
        require(
            block.timestamp - lastOracleUpdate <= ORACLE_TIMEOUT,
            "Oracle: price too old"
        );
        _;
    }

    // ── Constructor ───────────────────────────────────────────
    constructor(address admin, address _oracle)
        ERC20("Qredit", "QRDT")
        EIP712("Qredit", "1")
    {
        require(admin   != address(0), "Admin cannot be zero address");
        require(_oracle != address(0), "Oracle cannot be zero address");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE,        admin);
        _grantRole(STABILIZER_ROLE,    admin);
        _grantRole(RESERVE_ROLE,       admin);
        _grantRole(PAUSER_ROLE,        admin);

        oracle           = IBasketOracle(_oracle);
        lastOraclePrice  = TARGET_PRICE;
        lastOracleUpdate = block.timestamp;
        feeRecipient     = admin;

        feeExempt[address(this)] = true;
    }

    // ================================================================
    //  ORACLE
    // ================================================================

    function setOracle(address _oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_oracle != address(0), "Oracle cannot be zero address");
        emit OracleUpdated(address(oracle), _oracle);
        oracle = IBasketOracle(_oracle);
    }

    function refreshPrice() public returns (uint256 price, bool valid) {
        (price, valid, ) = oracle.getPrice();
        if (valid) {
            lastOraclePrice  = price;
            lastOracleUpdate = block.timestamp;
        }
        emit PriceRefreshed(price, valid);
    }

    // ================================================================
    //  RESERVE MANAGEMENT
    // ================================================================

    function addReserveAsset(
        address token,
        string calldata symbol,
        uint256 initialPriceUSD8,
        bool    isStable
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(0),                          "Token cannot be zero address");
        require(!reserveAssets[token].active,                 "Asset already registered");
        require(initialPriceUSD8 > 0,                         "Price must be positive");
        require(reserveAssetList.length < MAX_RESERVE_ASSETS, "Reserve asset limit reached");

        reserveAssets[token] = ReserveAsset({
            token:           token,
            symbol:          symbol,
            balance:         0,
            priceUSD8:       initialPriceUSD8,
            lastPriceUpdate: block.timestamp,
            active:          true,
            isStable:        isStable
        });
        reserveAssetList.push(token);
        emit ReserveAssetAdded(token, symbol);
    }

    function deactivateReserveAsset(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(reserveAssets[token].active, "Asset not active");
        reserveAssets[token].active = false;
        emit ReserveAssetDeactivated(token);
    }

    function depositReserve(
        address token,
        uint256 amount
    ) external onlyRole(RESERVE_ROLE) nonReentrant {
        ReserveAsset storage r = reserveAssets[token];
        require(r.active,   "Asset not accepted");
        require(amount > 0, "Amount must be positive");

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        r.balance += amount;
        _recalcTotalReserve();

        emit ReserveDeposited(token, amount, amount * r.priceUSD8 / 1e18);
    }

    function withdrawReserve(
        address token,
        uint256 amount
    ) external onlyRole(RESERVE_ROLE) nonReentrant {
        ReserveAsset storage r = reserveAssets[token];
        require(r.balance >= amount, "Insufficient reserve balance");

        r.balance -= amount;
        _recalcTotalReserve();

        require(
            totalSupply() == 0 || _currentReserveRatio() >= MIN_RESERVE_RATIO,
            "Withdrawal would break minimum reserve ratio"
        );

        IERC20(token).safeTransfer(msg.sender, amount);
        emit ReserveWithdrawn(token, amount);
    }

    function updateReservePrice(
        address token,
        uint256 priceUSD8
    ) external onlyRole(RESERVE_ROLE) {
        require(reserveAssets[token].active, "Asset not registered");
        require(priceUSD8 > 0,               "Price must be positive");

        reserveAssets[token].priceUSD8       = priceUSD8;
        reserveAssets[token].lastPriceUpdate = block.timestamp;
        _recalcTotalReserve();
        emit ReservePriceUpdated(token, priceUSD8);
    }

    // ================================================================
    //  MINTING
    // ================================================================

    function mintBacked(
        address to,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) nonReentrant whenNotPaused oracleValid {
        require(to     != address(0),      "Recipient cannot be zero address");
        require(amount > 0,                "Amount must be positive");
        require(amount <= MAX_MINT_PER_TX, "Exceeds per-transaction mint limit");

        _freshPrice();

        uint256 ratioAfter = _reserveRatioAfterMint(amount);
        require(ratioAfter >= MIN_RESERVE_RATIO, "Insufficient reserves (minimum 150%)");

        backedSupply += amount;
        _mint(to, amount);
        emit MintBacked(to, amount, ratioAfter);
    }

    function mintAlgorithmic(
        address to,
        uint256 amount
    ) external onlyRole(STABILIZER_ROLE) nonReentrant whenNotPaused oracleValid {
        require(to     != address(0), "Recipient cannot be zero address");
        require(amount > 0,           "Amount must be positive");

        uint256 newAlgo  = algorithmicSupply + amount;
        uint256 newTotal = totalSupply() + amount;
        require(newTotal > 0, "Invalid supply state");

        uint256 newAlgoRatio = newAlgo * PRECISION / newTotal;
        require(newAlgoRatio <= MAX_ALGO_RATIO, "Exceeds algorithmic supply limit (20%)");

        algorithmicSupply += amount;
        _mint(to, amount);
        emit MintAlgorithmic(to, amount, newAlgoRatio);
    }

    // ================================================================
    //  BURNING
    // ================================================================

    function burn(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be positive");
        _reduceSupplyTracking(amount);
        _burn(msg.sender, amount);
        emit Burned(msg.sender, amount);
    }

    function burnFrom(address from, uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be positive");
        _spendAllowance(from, msg.sender, amount);
        _reduceSupplyTracking(amount);
        _burn(from, amount);
        emit Burned(from, amount);
    }

    // ================================================================
    //  STABILIZATION
    // ================================================================

    function stabilize() external onlyRole(STABILIZER_ROLE) nonReentrant whenNotPaused {
        require(
            block.timestamp >= lastStabilizeTime + STABILIZE_COOLDOWN,
            "Stabilize: cooldown active"
        );

        (uint256 price, bool valid, ) = oracle.getPrice();
        require(valid, "Oracle: price not valid");

        lastStabilizeTime = block.timestamp;
        uint256 upper = TARGET_PRICE + STABILITY_BAND;
        uint256 lower = TARGET_PRICE - STABILITY_BAND;

        if (price > upper) {
            uint256 adj = _calcAdjustment(price, TARGET_PRICE);
            algorithmicSupply += adj;
            _mint(address(this), adj);
            emit Stabilized("expand", adj, price);
        } else if (price < lower) {
            uint256 adj    = _calcAdjustment(TARGET_PRICE, price);
            uint256 avail  = balanceOf(address(this));
            uint256 toBurn = adj <= avail ? adj : avail;
            if (toBurn > 0) {
                _reduceSupplyTracking(toBurn);
                _burn(address(this), toBurn);
                emit Stabilized("contract", toBurn, price);
            }
        }
    }

    // ================================================================
    //  GOVERNANCE
    // ================================================================

    function setTransferFee(
        uint256 feeBps,
        address recipient
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(feeBps    <= MAX_TRANSFER_FEE, "Fee exceeds maximum (1%)");
        require(recipient != address(0),        "Recipient cannot be zero address");
        transferFeeBps = feeBps;
        feeRecipient   = recipient;
        emit FeeUpdated(feeBps, recipient);
    }

    function setFeeExempt(address account, bool exempt) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeExempt[account] = exempt;
        emit FeeExemptUpdated(account, exempt);
    }

    function pause()   external onlyRole(PAUSER_ROLE) { _pause();   }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    // ================================================================
    //  VIEWS
    // ================================================================

    function reserveRatio() external view returns (uint256) {
        return _currentReserveRatio();
    }

    function algoRatio() external view returns (uint256) {
        if (totalSupply() == 0) return 0;
        return algorithmicSupply * PRECISION / totalSupply();
    }

    function reserveAssetCount() external view returns (uint256) {
        return reserveAssetList.length;
    }

    function systemStatus() external view returns (
        uint256 supply_,
        uint256 backed_,
        uint256 algo_,
        uint256 reserveUSD8_,
        uint256 oraclePrice_,
        bool    oracleValid_,
        bool    paused_,
        uint256 reserveRatio_
    ) {
        (uint256 p, bool v, ) = oracle.getPrice();
        return (
            totalSupply(),
            backedSupply,
            algorithmicSupply,
            totalReserveUSD8,
            p,
            v,
            paused(),
            _currentReserveRatio()
        );
    }

    // ================================================================
    //  INTERNAL HELPERS
    // ================================================================

    function _freshPrice() internal {
        (uint256 price, bool valid, ) = oracle.getPrice();
        require(valid, "Oracle: price not valid");
        lastOraclePrice  = price;
        lastOracleUpdate = block.timestamp;
    }

    function _currentReserveRatio() internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return type(uint256).max;
        uint256 supplyUSD8 = supply * lastOraclePrice / 1e18;
        if (supplyUSD8 == 0) return type(uint256).max;
        return totalReserveUSD8 * PRECISION / supplyUSD8;
    }

    function _reserveRatioAfterMint(uint256 mintAmount) internal view returns (uint256) {
        uint256 newSupply     = totalSupply() + mintAmount;
        uint256 newSupplyUSD8 = newSupply * lastOraclePrice / 1e18;
        if (newSupplyUSD8 == 0) return type(uint256).max;
        return totalReserveUSD8 * PRECISION / newSupplyUSD8;
    }

    function _recalcTotalReserve() internal {
        uint256 total = 0;
        for (uint256 i = 0; i < reserveAssetList.length; i++) {
            ReserveAsset storage r = reserveAssets[reserveAssetList[i]];
            if (r.active && r.balance > 0) {
                total += r.balance * r.priceUSD8 / 1e18;
            }
        }
        totalReserveUSD8 = total;
        emit TotalReserveUpdated(total);
    }

    function _reduceSupplyTracking(uint256 amount) internal {
        if (algorithmicSupply >= amount) {
            algorithmicSupply -= amount;
        } else {
            uint256 remainder = amount - algorithmicSupply;
            algorithmicSupply = 0;
            if (backedSupply >= remainder) backedSupply -= remainder;
        }
    }

    function _calcAdjustment(uint256 high, uint256 low) internal view returns (uint256) {
        uint256 dev = (high - low) * PRECISION / TARGET_PRICE;
        return totalSupply() * dev / PRECISION / 10;
    }

    /// @dev FIX MEDIO-02 — fee logic + ERC20Votes hook
    /// ERC20Votes requires _update to be overridden from both ERC20 and ERC20Votes.
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20Votes) {
        if (
            transferFeeBps > 0 &&
            from != address(0) &&
            to   != address(0) &&
            !feeExempt[from]   &&
            !feeExempt[to]
        ) {
            uint256 fee = amount * transferFeeBps / 10_000;
            if (fee > 0) {
                super._update(from, feeRecipient, fee);
                amount -= fee;
            }
        }
        super._update(from, to, amount);
    }

}
