import { normalizePlace, type AddressParts, type AludelPlace } from "../shared/model";

let loading: Promise<void> | null = null;

/**
 * Load the Maps JavaScript API once, by direct script with loading=async, and
 * resolve when google.maps.importLibrary is ready. Nothing is loaded until a
 * screen actually needs a map, so plain browsing never bills a map load.
 */
export function loadMaps(key: string): Promise<void> {
  return (loading ??= new Promise<void>((resolve, reject) => {
    if (typeof window.google?.maps?.importLibrary === "function") return resolve();
    const callback = "__aludelMapsReady";
    (window as unknown as Record<string, unknown>)[callback] = () => resolve();
    const script = document.createElement("script");
    const q = new URLSearchParams({ key, v: "weekly", loading: "async", callback });
    script.src = `https://maps.googleapis.com/maps/api/js?${q}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error("Google Maps failed to load"));
    };
    document.head.appendChild(script);
  }));
}

/** The only fields ever requested: one fetchFields per selection, nothing beyond what is stored. */
export const PLACE_FIELDS = ["id", "displayName", "formattedAddress", "location", "viewport", "addressComponents", "types"];

// address component type → which part it fills, and whether the short form is wanted
const PART: Record<string, [keyof AddressParts, "long" | "short"]> = {
  street_number: ["streetNumber", "long"],
  route: ["route", "long"],
  locality: ["locality", "long"],
  postal_town: ["locality", "long"],
  sublocality_level_1: ["locality", "long"],
  administrative_area_level_1: ["adminArea1", "short"],
  administrative_area_level_2: ["adminArea2", "long"],
  postal_code: ["postalCode", "long"],
  country: ["country", "long"],
};

/**
 * Normalize a fetched google.maps.places.Place into the record we store. Runs
 * through the same gate the server applies, so the client can never stage a
 * place the server would refuse.
 */
export function toAludelPlace(place: google.maps.places.Place): AludelPlace | null {
  const address: AddressParts = {};
  for (const c of place.addressComponents ?? []) {
    for (const t of c.types) {
      const part = PART[t];
      if (!part) continue;
      const [key, form] = part;
      // a true locality beats postal_town / sublocality stand-ins
      if (key === "locality" && t !== "locality" && address.locality) continue;
      const v = (form === "short" ? c.shortText : c.longText) ?? c.longText ?? c.shortText ?? "";
      if (v) address[key] = v;
      if (t === "country" && c.shortText) address.countryCode = c.shortText;
    }
  }
  return normalizePlace({
    googlePlaceId: place.id,
    name: place.displayName ?? "",
    formattedAddress: place.formattedAddress ?? "",
    lat: place.location?.lat(),
    lng: place.location?.lng(),
    viewport: place.viewport?.toJSON(),
    address,
    types: place.types ?? [],
    fetchedAt: new Date().toISOString(),
  });
}
