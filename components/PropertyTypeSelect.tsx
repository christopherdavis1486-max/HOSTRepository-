"use client";

const PROPERTY_TYPES = ["Apartment", "House", "Hotel", "Aparthotel"];

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  translate: (label: string) => string;
};

export function PropertyTypeSelect({ id, value, onChange, translate }: Props) {
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{translate("Select property type")}</option>
      {value && !PROPERTY_TYPES.includes(value) && (
        <option value={value}>{translate(value)}</option>
      )}
      {PROPERTY_TYPES.map((type) => (
        <option key={type} value={type}>{translate(type)}</option>
      ))}
    </select>
  );
}
