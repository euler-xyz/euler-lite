export const vaultTypeDescriptions: Record<string, string> = {
  governed: 'Governed vaults have a DAO, risk manager, or other governor that may control parameters such as interest rates, collateral settings, and loan-to-value ratios. Users should review the governor, market configuration, and risks before supplying or borrowing.',
  escrow: 'Escrow vaults hold deposits that do not earn interest because the vault does not allow borrowing. They are typically used as collateral for taking out loans from other vaults. They are ungoverned and have no active risk management.',
  managed: 'Curated vaults hold supplied assets that may be allocated across multiple strategies according to parameters set by the curator. Review the curator, fees, caps, strategy composition, and risks before supplying.',
  ungoverned: 'Ungoverned vaults have no active governor managing their risk parameters. Their configuration is immutable. Depositors should assess risk independently.',
  governanceLimited: 'Vaults with limited governance have a governor who may have authority to adjust certain parameters, but there is no active risk manager monitoring and managing them on an ongoing basis. Depositors should assess risk independently.',
  securitize: 'Securitize vaults hold tokenized real-world assets that may be used as collateral for taking out loans from other vaults. They are powered by the DS Protocol — a blockchain-based framework by Securitize for the regulated issuance, management, and trading of digital securities and tokenized assets, integrating ERC-20 compatible security tokens with onchain services for identity, regulation, and compliance.',
  unknown: 'This vault\'s governor has not been verified. Interacting with unknown and unverified vaults may pose security risks, as such vaults could potentially be used for phishing attempts. Ensure you trust the source before continuing.',
}

export const vaultTypeLabels: Record<string, string> = {
  governed: 'Governed',
  managed: 'Curated',
  escrow: 'Escrowed collateral',
  securitize: 'Securitize Digital Security',
  ungoverned: 'Ungoverned',
  governanceLimited: 'Limited',
  unknown: 'Unknown',
}

export function getVaultTypeLabel(type: string, isVerified: boolean): string {
  if (!isVerified) {
    return vaultTypeLabels.unknown
  }
  return vaultTypeLabels[type] ?? vaultTypeLabels.unknown
}

export function getVaultTypeDescription(type: string, isVerified: boolean): string {
  if (!isVerified) {
    return vaultTypeDescriptions.unknown
  }
  return vaultTypeDescriptions[type] ?? vaultTypeDescriptions.unknown
}
