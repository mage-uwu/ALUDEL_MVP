// The slice of the Maps JavaScript API this app touches, declared by hand so the
// build stays dependency-free. Shapes follow the current (non-legacy) Places
// classes: Place, PlaceAutocompleteElement (gmp-select) and AdvancedMarkerElement.
declare namespace google.maps {
  interface LatLngLiteral {
    lat: number;
    lng: number;
  }
  interface LatLngBoundsLiteral {
    north: number;
    south: number;
    east: number;
    west: number;
  }
  class LatLng {
    lat(): number;
    lng(): number;
  }
  class LatLngBounds {
    toJSON(): LatLngBoundsLiteral;
  }
  interface MapOptions {
    mapId?: string;
    center?: LatLngLiteral;
    zoom?: number;
    disableDefaultUI?: boolean;
    zoomControl?: boolean;
    gestureHandling?: "cooperative" | "greedy" | "none" | "auto";
    clickableIcons?: boolean;
  }
  class Map {
    constructor(el: HTMLElement, opts?: MapOptions);
    fitBounds(bounds: LatLngBounds | LatLngBoundsLiteral, padding?: number): void;
    setCenter(center: LatLngLiteral): void;
    setZoom(zoom: number): void;
  }
  interface MapsLibrary {
    Map: typeof Map;
  }
  interface MarkerLibrary {
    AdvancedMarkerElement: typeof marker.AdvancedMarkerElement;
  }
  interface PlacesLibrary {
    PlaceAutocompleteElement: typeof places.PlaceAutocompleteElement;
  }
  function importLibrary(name: "maps"): Promise<MapsLibrary>;
  function importLibrary(name: "marker"): Promise<MarkerLibrary>;
  function importLibrary(name: "places"): Promise<PlacesLibrary>;

  namespace marker {
    interface AdvancedMarkerElementOptions {
      map?: Map | null;
      position?: LatLngLiteral | null;
      title?: string;
    }
    class AdvancedMarkerElement extends HTMLElement {
      constructor(opts?: AdvancedMarkerElementOptions);
      map: Map | null;
      position: LatLngLiteral | null;
      title: string;
    }
  }

  namespace places {
    interface AddressComponent {
      longText: string | null;
      shortText: string | null;
      types: string[];
    }
    class Place {
      id: string;
      displayName?: string | null;
      formattedAddress?: string | null;
      location?: LatLng | null;
      viewport?: LatLngBounds | null;
      addressComponents?: AddressComponent[] | null;
      types?: string[] | null;
      fetchFields(opts: { fields: string[] }): Promise<{ place: Place }>;
    }
    interface PlacePrediction {
      toPlace(): Place;
    }
    interface PlacePredictionSelectEvent extends Event {
      placePrediction: PlacePrediction;
    }
    class PlaceAutocompleteElement extends HTMLElement {}
  }
}

interface Window {
  google?: { maps?: typeof google.maps };
}
