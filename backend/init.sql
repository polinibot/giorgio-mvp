-- Inizializzazione database Giorgio
-- Schema relazionale per pratiche meccanico

-- Estensione per array di enum
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enum per status pratica
CREATE TYPE practice_status AS ENUM (
    'draft',
    'confirmed', 
    'deleted',
    'sync_pending',
    'synced',
    'sync_failed'
);

-- Enum per tipo pratica
CREATE TYPE practice_type AS ENUM (
    'preventivo',
    'ordine_di_lavoro'
);

-- Enum per tipo cliente
CREATE TYPE customer_type AS ENUM (
    'privato',
    'azienda'
);

-- Enum per contesti
CREATE TYPE context AS ENUM (
    'officina',
    'carrozzeria', 
    'revisione'
);

-- Tabella pratiche
CREATE TABLE practices (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by_telegram_id INTEGER NOT NULL,
    updated_by_telegram_id INTEGER,
    status practice_status DEFAULT 'draft',
    plate_detected VARCHAR(20),
    plate_confirmed VARCHAR(20) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    customer_name VARCHAR(200) NOT NULL,
    customer_type customer_type NOT NULL,
    billing_to_complete BOOLEAN DEFAULT FALSE,
    appointment_date DATE NOT NULL,
    appointment_time VARCHAR(5) NOT NULL, -- HH:MM format
    practice_type practice_type NOT NULL,
    contexts context[] NOT NULL,
    internal_notes TEXT,
    management_external_id VARCHAR(100),
    management_sync_status VARCHAR(50),
    management_last_sync_at TIMESTAMP WITH TIME ZONE
);

-- Tabella foto pratiche
CREATE TABLE practice_photos (
    id SERIAL PRIMARY KEY,
    practice_id INTEGER NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
    telegram_file_id VARCHAR(500) NOT NULL,
    storage_path VARCHAR(500) NOT NULL,
    ocr_result VARCHAR(20),
    ocr_confidence FLOAT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabella sezioni pratiche
CREATE TABLE practice_sections (
    id SERIAL PRIMARY KEY,
    practice_id INTEGER NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
    context context NOT NULL,
    description_rows TEXT[] NOT NULL,
    man_hours FLOAT,
    mac_hours FLOAT,
    materials_amount FLOAT,
    waste_apply BOOLEAN,
    waste_percentage FLOAT
);

-- Tabella pezzi pratiche
CREATE TABLE practice_parts (
    id SERIAL PRIMARY KEY,
    practice_id INTEGER NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
    context context NOT NULL,
    name VARCHAR(200) NOT NULL,
    quantity VARCHAR(50) -- Testuale: "1 pz", "2 pz", "3,5 kg"
);

-- Indici per performance
CREATE INDEX idx_practices_status ON practices(status);
CREATE INDEX idx_practices_created_by ON practices(created_by_telegram_id);
CREATE INDEX idx_practices_appointment ON practices(appointment_date, appointment_time);
CREATE INDEX idx_practices_plate ON practices(plate_confirmed);
CREATE INDEX idx_practice_photos_practice ON practice_photos(practice_id);
CREATE INDEX idx_practice_sections_practice ON practice_sections(practice_id);
CREATE INDEX idx_practice_parts_practice ON practice_parts(practice_id);

-- Trigger per aggiornare updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_practices_updated_at 
    BEFORE UPDATE ON practices 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Constraint per validare formato tempo (HH:MM con minuti 00 o 30)
ALTER TABLE practices ADD CONSTRAINT check_appointment_time 
    CHECK (appointment_time ~ '^([01]?[0-9]|2[0-3]):[03]0$');

-- Constraint per validare percentuale smaltimento
ALTER TABLE practice_sections ADD CONSTRAINT check_waste_percentage 
    CHECK (waste_percentage IS NULL OR (waste_percentage >= 0 AND waste_percentage <= 100));

-- Constraint per validare ore manodopera
ALTER TABLE practice_sections ADD CONSTRAINT check_man_hours 
    CHECK (man_hours IS NULL OR man_hours >= 0);

ALTER TABLE practice_sections ADD CONSTRAINT check_mac_hours 
    CHECK (mac_hours IS NULL OR mac_hours >= 0);

-- Commenti per documentazione
COMMENT ON TABLE practices IS 'Tabella principale delle pratiche meccanico';
COMMENT ON TABLE practice_photos IS 'Foto associate alle pratiche';
COMMENT ON TABLE practice_sections IS 'Sezioni per contesto (officina/carrozzeria/revisione)';
COMMENT ON TABLE practice_parts IS 'Pezzi e ricambi per pratica';

COMMENT ON COLUMN practices.contexts IS 'Array di contesti: può contenere uno o più valori tra officina, carrozzeria, revisione';
COMMENT ON COLUMN practices.appointment_time IS 'Ora appuntamento in formato HH:MM, minuti devono essere 00 o 30 (slot 30 min)';
COMMENT ON COLUMN practice_parts.quantity IS 'Quantità testuale: es. "1 pz", "2 pz", "3,5 kg", "5L"';
