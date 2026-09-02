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
    constructor();
    extend(point: LatLngLiteral): LatLngBounds;
    toJSON(): LatLngBoundsLiteral;
  }
  interface PolylineOptions {
    map?: Map | null;
    path: LatLngLiteral[];
    strokeColor?: string;
    strokeWeight?: number;
    strokeOpacity?: number;
  }
  class Polyline {
    constructor(opts: PolylineOptions);
    setMap(map: Map | null): void;
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
    Polyline: typeof Polyline;
  }
  interface MarkerLibrary {
    AdvancedMarkerElement: typeof marker.AdvancedMarkerElement;
    PinElement: typeof marker.PinElement;
  }
  interface GeometryLibrary {
    encoding: typeof geometry.encoding;
  }
  namespace geometry.encoding {
    function decodePath(encoded: string): LatLng[];
  }
  interface PlacesLibrary {
    PlaceAutocompleteElement: typeof places.PlaceAutocompleteElement;
  }
  function importLibrary(name: "maps"): Promise<MapsLibrary>;
  function importLibrary(name: "marker"): Promise<MarkerLibrary>;
  function importLibrary(name: "places"): Promise<PlacesLibrary>;
  function importLibrary(name: "geometry"): Promise<GeometryLibrary>;

  namespace marker {
    interface AdvancedMarkerElementOptions {
      map?: Map | null;
      position?: LatLngLiteral | null;
      title?: string;
      content?: Element | null;
    }
    class PinElement {
      constructor(opts?: { background?: string; borderColor?: string; glyphColor?: string; glyph?: string; scale?: number });
      element: HTMLElement;
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
