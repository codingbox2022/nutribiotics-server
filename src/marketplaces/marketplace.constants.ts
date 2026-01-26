export const DEFAULT_MARKETPLACE_NAME = 'Nutrabiotics Store';

export const isDefaultMarketplaceName = (name?: string | null): boolean => {
  if (!name) {
    return false;
  }
  return name.trim().toLowerCase() === DEFAULT_MARKETPLACE_NAME.toLowerCase();
};
