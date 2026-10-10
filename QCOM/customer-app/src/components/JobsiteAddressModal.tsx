import React from 'react';
import { AddressLocation } from '../types';
import { LocationPage } from './LocationPage';

interface AddressModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentLocation: AddressLocation;
  onSaveLocation: (loc: AddressLocation) => void;
}

export const AddressModal: React.FC<AddressModalProps> = ({
  isOpen,
  onClose,
  currentLocation,
  onSaveLocation,
}) => {
  if (!isOpen) return null;

  return (
    <LocationPage
      currentLocation={currentLocation}
      onSaveLocation={onSaveLocation}
      onClose={onClose}
    />
  );
};

export const JobsiteAddressModal = AddressModal;
