// Saved workflows and prompt sets carry their picture labels, including older copies of the starter.
export function usesPlaceAndPerson(model, slots) {
  return Boolean(model?.characterSheet && slots?.[0]?.label === 'Place' && slots[1]?.label === 'Person');
}
