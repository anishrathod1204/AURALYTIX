import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import { useEffect } from "react";
import { MapPin } from "lucide-react";
import "leaflet/dist/leaflet.css";

function Recenter({ center }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom());
  }, [center, map]);
  return null;
}

export default function MapView({ center }) {
  if (!Array.isArray(center) || center.length !== 2 || center.some((part) => !Number.isFinite(Number(part)))) return null;
  const position = center.map(Number);
  if (Math.abs(position[0]) > 90 || Math.abs(position[1]) > 180) return null;
  return (
    <div className="map-wrap">
      <div className="map-heading"><MapPin aria-hidden="true" size={14} />Location returned by weather provider</div>
      <MapContainer center={position} zoom={7} className="result-map" scrollWheelZoom={false}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="© OpenStreetMap contributors"
        />
        <Marker position={position}><Popup>Provider-reported weather location</Popup></Marker>
        <Recenter center={position} />
      </MapContainer>
    </div>
  );
}
