// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CollateralAttestor
 * @notice Source-chain (Sepolia) recorder of collateral facts for the Cyberken module.
 * @dev A borrower records a collateral fact (MVP: a single uint256 representing a balance
 *      snapshot or a credential flag). Recording emits {CollateralFactRecorded}. The
 *      Creditcoin-side {CreditLineManager} later proves that event via the Attestcoin
 *      protocol (no bridge, no centralized oracle) before unlocking credit.
 *
 *      This contract is the *only* emitter a registered {CreditLineManager} trusts —
 *      the ASC binds `log.address_ == sourceCollateralAttestor`.
 */
contract CollateralAttestor {
    /// @notice Emitted whenever a borrower (re)records their collateral fact.
    /// @param borrower The address recording the fact (`msg.sender`).
    /// @param factValue The recorded collateral value (balance snapshot / credential flag).
    /// @param timestamp When the fact was recorded (`block.timestamp`).
    event CollateralFactRecorded(address indexed borrower, uint256 factValue, uint256 timestamp);

    /// @notice A borrower's recorded collateral fact.
    struct RecordedFact {
        uint256 value;
        uint256 timestamp;
    }

    /// @notice Latest fact per borrower (kept on-chain for readback by any party).
    mapping(address => RecordedFact) public facts;

    /**
     * @notice Record a new collateral fact for the caller.
     * @dev Storing the fact keeps the source chain self-consistent; the emitted event is
     *      what the Creditcoin oracle proves to the {CreditLineManager}.
     * @param factValue The collateral value to record.
     */
    function recordCollateralFact(uint256 factValue) external {
        facts[msg.sender] = RecordedFact({ value: factValue, timestamp: block.timestamp });

        emit CollateralFactRecorded(msg.sender, factValue, block.timestamp);
    }
}